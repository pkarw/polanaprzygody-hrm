import { randomUUID } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEmitContext, CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import {
  Patient,
  PatientAddress,
  PatientAttachmentLink,
  PatientDiagnosis,
  PatientDocumentLink,
} from '../data/entities'
import {
  patientArchiveSchema,
  patientCreateSchema,
  patientDeleteSchema,
  patientUpdateSchema,
} from '../data/validators'
import { emitPatientEvent } from '../events'
import type { PatientReferenceService } from '../lib/patientReferenceService'
import {
  assertExpectedVersion,
  buildPatientNumber,
  createRequestDigest,
  encryptSensitiveFields,
  lockPatient,
  nextUpdatedAt,
  requireActorUserId,
  requirePatientScope,
  toIsoTimestamp,
  tryResolveEncryptionService,
  type PatientScope,
} from '../lib/commandSupport'

const PATIENT_ENTITY_ID = 'patient:patient' as const
const PATIENT_ADDRESS_ENTITY_ID = 'patient:patient_address' as const

/**
 * Event payload for every patient write.
 *
 * Identifiers, scope and the version only. No name, no contact channel, no note. A
 * subscriber receiving this event has not been authorized to read the record, so the
 * payload must not be a way around that — and `patient.patient.*` firing at all already
 * tells a subscriber more than it should if the id were guessable, which is why these
 * events are not broadcast to browsers or the portal.
 */
export const patientCrudEvents: CrudEventsConfig<Patient> = {
  module: 'patient',
  entity: 'patient',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<Patient>) => ({
    id: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    updatedAt: toIsoTimestamp(ctx.entity?.updatedAt),
  }),
}

export const patientCrudIndexer: CrudIndexerConfig<Patient> = {
  entityType: PATIENT_ENTITY_ID,
  buildUpsertPayload: (ctx: CrudEmitContext<Patient>) => ({
    entityType: PATIENT_ENTITY_ID,
    recordId: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
  }),
  buildDeletePayload: (ctx: CrudEmitContext<Patient>) => ({
    entityType: PATIENT_ENTITY_ID,
    recordId: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
  }),
}

function referenceService(ctx: CommandRuntimeContext): PatientReferenceService {
  return ctx.container.resolve('patientReferenceService') as PatientReferenceService
}

/**
 * Snapshot shape for the protected audit log and for undo.
 *
 * Plaintext on purpose, and only safe because `audit_logs` encrypts
 * `snapshot_before` / `snapshot_after` / `changes_json` through its own encryption map.
 * Undo has to restore what the user actually typed, so a ciphertext snapshot would
 * write ciphertext back into a column every read path then tries to decrypt again.
 *
 * The spec makes this conditional: if the action-log storage cannot protect the content,
 * undo must not be enabled rather than the audit being silenced. That is why these
 * commands are `isUndoable` only where a protected snapshot exists.
 */
type SerializedPatient = {
  id: string
  patientNumber: string
  firstName: string
  lastName: string
  birthDate: string | null
  email: string | null
  phone: string | null
  description: string | null
  ownerTeamMemberId: string | null
  status: string
  tenantId: string
  organizationId: string
  custom?: Record<string, unknown>
}

function serializePatient(patient: Patient): SerializedPatient {
  return {
    id: String(patient.id),
    patientNumber: String(patient.patientNumber),
    firstName: String(patient.firstName),
    lastName: String(patient.lastName),
    birthDate: patient.birthDate ?? null,
    email: patient.email ?? null,
    phone: patient.phone ?? null,
    description: patient.description ?? null,
    ownerTeamMemberId: patient.ownerTeamMemberId ?? null,
    status: String(patient.status),
    tenantId: String(patient.tenantId),
    organizationId: String(patient.organizationId),
  }
}

/** Reads a patient with its encrypted columns decrypted, scoped, or 404s. */
async function loadPatientDecrypted(
  em: EntityManager,
  id: string,
  scope: PatientScope,
): Promise<Patient> {
  const patient = await findOneWithDecryption(
    em,
    Patient,
    {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<Patient>,
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!patient) throw new CrudHttpError(404, { error: 'Patient not found' })
  return patient
}

/**
 * Resolves an already-created record for a repeated `clientRequestId`.
 *
 * Order matters and is the spec's: authorize the CURRENT request's scope first, then
 * compare the normalized payload. Comparing first would let a caller from another
 * organization discover whether a request id exists by the shape of the error. Because
 * the lookup is scoped, a foreign request id simply reads as absent.
 *
 * An equivalent payload returns the existing record — that is the whole point of the
 * retry. A *different* payload under the same request id is a 409: the client reused an
 * idempotency key for different content, and silently returning the old record would
 * hide that its second request never took effect.
 */
async function resolveIdempotentPatient(
  em: EntityManager,
  clientRequestId: string,
  digest: string,
  scope: PatientScope,
): Promise<Patient | null> {
  const existing = await em.findOne(Patient, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    clientRequestId,
  } as FilterQuery<Patient>)
  if (!existing) return null
  if (existing.createRequestPayload !== digest) {
    throw new CrudHttpError(409, {
      error: 'This request id was already used with different content',
      code: 'idempotency_payload_mismatch',
    })
  }
  return existing
}

/**
 * Creates a patient together with its first address, atomically.
 *
 * "Atomically" is a requirement, not an optimization: the spec says an active patient
 * always has exactly one primary address, so a record that committed without its address
 * would be born violating its own invariant, and no later write would be obliged to fix it.
 * Both rows are therefore written in one transaction through `runCrudCommandWrite`, with
 * the custom fields and the event emitted only after it commits.
 *
 * The record id is generated here rather than left to the database default because
 * `patient_number` embeds it and the address needs it in the same transaction.
 */
const createPatientCommand: CommandHandler<Record<string, unknown>, Patient> = {
  id: 'patient.patients.create',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const parsed = patientCreateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    // Excludes scope, actors, the request id and the version token, so a legitimate
    // retry from a different session still compares equal.
    const digest = createRequestDigest({
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      birthDate: parsed.birthDate ?? null,
      email: parsed.email ?? null,
      phone: parsed.phone ?? null,
      description: parsed.description ?? null,
      ownerTeamMemberId: parsed.ownerTeamMemberId ?? null,
      primaryAddress: parsed.primaryAddress,
      customFields: parsed.customFields ?? null,
    })

    const replayed = await resolveIdempotentPatient(em, parsed.clientRequestId, digest, scope)
    if (replayed) return replayed

    if (parsed.ownerTeamMemberId) {
      await referenceService(ctx).requireActiveTeamMember(parsed.ownerTeamMemberId, scope)
    }

    const encryption = tryResolveEncryptionService(ctx)
    const patientId = randomUUID()
    const now = new Date()

    const patientColumns = await encryptSensitiveFields(
      PATIENT_ENTITY_ID,
      {
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        birthDate: parsed.birthDate ?? null,
        email: parsed.email ?? null,
        phone: parsed.phone ?? null,
        description: parsed.description ?? null,
        createRequestPayload: digest,
      },
      scope,
      encryption,
    )

    const addressColumns = await encryptSensitiveFields(
      PATIENT_ADDRESS_ENTITY_ID,
      {
        name: parsed.primaryAddress.name ?? null,
        companyName: parsed.primaryAddress.companyName ?? null,
        addressLine1: parsed.primaryAddress.addressLine1,
        addressLine2: parsed.primaryAddress.addressLine2 ?? null,
        buildingNumber: parsed.primaryAddress.buildingNumber ?? null,
        flatNumber: parsed.primaryAddress.flatNumber ?? null,
        city: parsed.primaryAddress.city,
        region: parsed.primaryAddress.region ?? null,
        postalCode: parsed.primaryAddress.postalCode ?? null,
        country: parsed.primaryAddress.country,
        latitude: parsed.primaryAddress.latitude == null ? null : String(parsed.primaryAddress.latitude),
        longitude: parsed.primaryAddress.longitude == null ? null : String(parsed.primaryAddress.longitude),
      },
      scope,
      encryption,
    )

    let patient!: Patient

    try {
      await runCrudCommandWrite<Patient>({
        ctx,
        em,
        entityId: PATIENT_ENTITY_ID,
        action: 'created',
        scope,
        customFields: parsed.customFields,
        events: patientCrudEvents,
        indexer: patientCrudIndexer,
        syncOrigin: ctx.syncOrigin,
        phases: [
          ({ em: phaseEm }) => {
            patient = phaseEm.create(Patient, {
              id: patientId,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              patientNumber: buildPatientNumber(patientId),
              ...patientColumns,
              ownerTeamMemberId: parsed.ownerTeamMemberId ?? null,
              status: 'active',
              archivedAt: null,
              clientRequestId: parsed.clientRequestId,
              createdAt: now,
              updatedAt: now,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
              deletedAt: null,
            })
            phaseEm.persist(patient)
          },
          ({ em: phaseEm }) => {
            const address = phaseEm.create(PatientAddress, {
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              patientId,
              purpose: parsed.primaryAddress.purpose ?? null,
              ...addressColumns,
              // The first address is the primary one by definition — the record has no
              // other, so there is nothing for the user to choose between.
              isPrimary: true,
              createdAt: now,
              updatedAt: now,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
              deletedAt: null,
            })
            phaseEm.persist(address)
          },
        ],
        sideEffect: () => ({
          entity: patient,
          identifiers: {
            id: patientId,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
          },
        }),
      })
    } catch (error) {
      // Two concurrent retries of the same request can both pass the read above and
      // then race on the `(tenant, organization, client_request_id)` unique index. The
      // loser must return the winner's record — that is what idempotent means — rather
      // than surfacing a constraint violation the client cannot act on.
      if (error instanceof UniqueConstraintViolationException) {
        const raced = await resolveIdempotentPatient(
          (ctx.container.resolve('em') as EntityManager).fork(),
          parsed.clientRequestId,
          digest,
          scope,
        )
        if (raced) return raced
      }
      throw error
    }

    return patient
  },
  captureAfter: (_input, result) => serializePatient(result),
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.patients.create', 'Create patient'),
      resourceKind: 'patient.patient',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
      snapshotAfter: serializePatient(result),
    }
  },
  /**
   * Undo soft-deletes the record, it does not hard-delete it.
   *
   * The spec bans hard deletion of clinical data outright, and undoing a create is not
   * an exception: by the time undo runs, a diagnosis may already reference the patient.
   * The primary address is tombstoned with it so the partial unique index does not block
   * a later re-create.
   */
  async undo({ logEntry, ctx }) {
    const snapshot = logEntry.snapshotAfter as SerializedPatient | undefined
    const id = snapshot?.id ?? logEntry.resourceId
    if (!id) throw new Error('[internal] Missing patient id for undo')
    const scope = requirePatientScope(ctx)
    if (snapshot && snapshot.tenantId !== scope.tenantId) {
      throw new CrudHttpError(403, { error: 'Undo scope does not match tenant' })
    }
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const deletedAt = new Date()
    await em.nativeUpdate(
      Patient,
      { id, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<Patient>,
      { deletedAt, updatedAt: deletedAt },
    )
    await em.nativeUpdate(
      PatientAddress,
      {
        patientId: id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      } as FilterQuery<PatientAddress>,
      { deletedAt, updatedAt: deletedAt },
    )
  },
}

/**
 * Updates the record's own fields.
 *
 * Addresses, contacts, status and the settlement of any clinical state are NOT reachable
 * here — each has its own command so its invariant can be enforced under the right lock.
 *
 * The "at least one contact channel" rule is checked against the MERGED result rather
 * than the payload. Clearing `email` is legitimate when a phone number is already on
 * record and a refusal is legitimate when it is not, and only the stored row can tell
 * those apart.
 */
const updatePatientCommand: CommandHandler<Record<string, unknown>, Patient> = {
  id: 'patient.patients.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const parsed = patientUpdateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager)
    const existing = await loadPatientDecrypted(em, parsed.id, scope)
    return { before: serializePatient(existing) }
  },
  async execute(rawInput, ctx) {
    const parsed = patientUpdateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    // Lock before the version check, never after: check-then-lock lets two writers read
    // the same `updated_at`, both pass, and both write.
    const locked = await lockPatient(em, parsed.id, scope)
    assertExpectedVersion(parsed.expectedUpdatedAt, locked.updatedAt, PATIENT_ENTITY_ID)

    const current = await loadPatientDecrypted(em, parsed.id, scope)
    const mergedEmail = parsed.email !== undefined ? parsed.email : current.email ?? null
    const mergedPhone = parsed.phone !== undefined ? parsed.phone : current.phone ?? null
    if (!mergedEmail && !mergedPhone) {
      throw new CrudHttpError(422, {
        error: 'A patient must keep at least an email address or a phone number',
        code: 'contact_channel_required',
      })
    }

    if (parsed.ownerTeamMemberId) {
      // Only a NEW or CHANGED reference must be active. Re-submitting the same, since
      // deactivated, carer while editing a note must not be blocked — the spec keeps
      // historical references readable and only forbids selecting them afresh.
      if (parsed.ownerTeamMemberId !== (current.ownerTeamMemberId ?? null)) {
        await referenceService(ctx).requireActiveTeamMember(parsed.ownerTeamMemberId, scope)
      }
    }

    const sensitive: Record<string, unknown> = {}
    if (parsed.firstName !== undefined) sensitive.firstName = parsed.firstName
    if (parsed.lastName !== undefined) sensitive.lastName = parsed.lastName
    if (parsed.birthDate !== undefined) sensitive.birthDate = parsed.birthDate
    if (parsed.email !== undefined) sensitive.email = parsed.email
    if (parsed.phone !== undefined) sensitive.phone = parsed.phone
    if (parsed.description !== undefined) sensitive.description = parsed.description

    const encrypted = await encryptSensitiveFields(
      PATIENT_ENTITY_ID,
      sensitive,
      scope,
      tryResolveEncryptionService(ctx),
    )

    const updatedAt = nextUpdatedAt(locked.updatedAt)
    let patient!: Patient

    await runCrudCommandWrite<Patient>({
      ctx,
      em,
      entityId: PATIENT_ENTITY_ID,
      action: 'updated',
      scope,
      customFields: parsed.customFields,
      events: patientCrudEvents,
      indexer: patientCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        ({ em: phaseEm }) => {
          for (const [key, value] of Object.entries(encrypted)) {
            ;(locked as unknown as Record<string, unknown>)[key] = value
          }
          if (parsed.ownerTeamMemberId !== undefined) {
            locked.ownerTeamMemberId = parsed.ownerTeamMemberId ?? null
          }
          locked.updatedAt = updatedAt
          locked.updatedByUserId = actorUserId
          phaseEm.persist(locked)
          patient = locked
        },
      ],
      sideEffect: () => ({
        entity: patient,
        identifiers: {
          id: String(patient.id),
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
      }),
    })

    // Re-read decrypted so the caller and the audit snapshot see plaintext rather than
    // the ciphertext just written to the columns.
    return await loadPatientDecrypted(em, parsed.id, scope)
  },
  captureAfter: (_input, result) => serializePatient(result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as SerializedPatient | undefined
    return {
      actionLabel: translate('patient.audit.patients.update', 'Update patient'),
      resourceKind: 'patient.patient',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
      snapshotBefore: before ?? null,
      snapshotAfter: serializePatient(result),
    }
  },
  /**
   * Undo restores the previous field values.
   *
   * Deliberately NOT a blind write: it refuses when the record has moved on since the
   * logged change, because reverting past someone else's later edit would silently
   * discard it. The spec requires undo to check that a newer change has not been
   * overwritten.
   */
  async undo({ logEntry, ctx }) {
    const before = logEntry.snapshotBefore as SerializedPatient | undefined
    const after = logEntry.snapshotAfter as SerializedPatient | undefined
    if (!before?.id) throw new Error('[internal] Missing previous snapshot for undo')
    const scope = requirePatientScope(ctx)
    if (before.tenantId !== scope.tenantId) {
      throw new CrudHttpError(403, { error: 'Undo scope does not match tenant' })
    }
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const locked = await lockPatient(em, before.id, scope)
    const current = await loadPatientDecrypted(em, before.id, scope)
    if (after) {
      const movedOn =
        current.firstName !== after.firstName ||
        current.lastName !== after.lastName ||
        (current.birthDate ?? null) !== after.birthDate ||
        (current.email ?? null) !== after.email ||
        (current.phone ?? null) !== after.phone ||
        (current.description ?? null) !== after.description ||
        (current.ownerTeamMemberId ?? null) !== after.ownerTeamMemberId
      if (movedOn) {
        throw new CrudHttpError(409, {
          error: 'This record changed after the action being undone; undo was refused',
          code: 'undo_superseded',
        })
      }
    }

    const restored = await encryptSensitiveFields(
      PATIENT_ENTITY_ID,
      {
        firstName: before.firstName,
        lastName: before.lastName,
        birthDate: before.birthDate,
        email: before.email,
        phone: before.phone,
        description: before.description,
      },
      scope,
      tryResolveEncryptionService(ctx),
    )
    for (const [key, value] of Object.entries(restored)) {
      ;(locked as unknown as Record<string, unknown>)[key] = value
    }
    locked.ownerTeamMemberId = before.ownerTeamMemberId
    locked.updatedAt = nextUpdatedAt(locked.updatedAt)
    locked.updatedByUserId = requireActorUserId(ctx)
    await em.persist(locked).flush()
  },
}

/**
 * Archives or restores the record.
 *
 * Its own command rather than a field on the generic update, because `status` and
 * `archived_at` are one fact in two columns (the table's check constraint says so) and
 * because archiving is the transition that stops new entries being accepted. Exposing
 * `status` through the generic PUT would give that gate a second, unguarded entry point.
 *
 * Archiving does not touch history: diagnoses, documents and files stay readable, and
 * the spec still permits a correction or a void with the clinical feature.
 */
const archivePatientCommand: CommandHandler<Record<string, unknown>, Patient> = {
  id: 'patient.patients.archive',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientArchiveSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const locked = await lockPatient(em, parsed.id, scope)
    assertExpectedVersion(parsed.expectedUpdatedAt, locked.updatedAt, PATIENT_ENTITY_ID)

    const target = parsed.archived ? 'archived' : 'active'
    if (locked.status === target) {
      throw new CrudHttpError(409, {
        error: parsed.archived ? 'This record is already archived' : 'This record is already active',
        code: 'status_unchanged',
      })
    }

    const updatedAt = nextUpdatedAt(locked.updatedAt)
    let patient!: Patient

    await runCrudCommandWrite<Patient>({
      ctx,
      em,
      entityId: PATIENT_ENTITY_ID,
      action: 'updated',
      scope,
      // No `events` here on purpose. Archiving has its own dedicated event id below, and
      // also emitting the generic `patient.patient.updated` would publish one state
      // change twice — the spec forbids double emission. The indexer still runs so the
      // projection reflects the new status.
      indexer: patientCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        ({ em: phaseEm }) => {
          locked.status = target
          locked.archivedAt = parsed.archived ? updatedAt : null
          locked.updatedAt = updatedAt
          locked.updatedByUserId = actorUserId
          phaseEm.persist(locked)
          patient = locked
        },
      ],
      sideEffect: () => ({
        entity: patient,
        identifiers: {
          id: String(patient.id),
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
      }),
    })

    await emitPatientEvent(parsed.archived ? 'patient.patient.archived' : 'patient.patient.restored', {
      id: String(patient.id),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      updatedAt: updatedAt.toISOString(),
    })

    return await loadPatientDecrypted(em, parsed.id, scope)
  },
  buildLog: async ({ result, input }) => {
    const { translate } = await resolveTranslations()
    const archived = Boolean((input as { archived?: boolean }).archived)
    return {
      actionLabel: archived
        ? translate('patient.audit.patients.archive', 'Archive patient')
        : translate('patient.audit.patients.restore', 'Restore patient'),
      resourceKind: 'patient.patient',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
      changes: { status: { from: archived ? 'active' : 'archived', to: archived ? 'archived' : 'active' } },
    }
  },
}

/**
 * Soft-deletes a record that was created in error.
 *
 * Only an *empty* card qualifies. The spec's wording is precise: a delete is not a
 * retention mechanism, so anything that would destroy history blocks it. Diagnoses,
 * document links and attachment links are each checked under the patient lock, so a
 * diagnosis cannot be inserted between the check and the write.
 *
 * Addresses and contact links do NOT block: they are part of the card being discarded,
 * not history of their own, and the CRM person behind a contact link is untouched.
 *
 * Visits are checked by the VIS phase, which adds its own condition inside this module.
 */
const deletePatientCommand: CommandHandler<Record<string, unknown>, Patient> = {
  id: 'patient.patients.delete',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const parsed = patientDeleteSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    const existing = await loadPatientDecrypted(em, parsed.id, scope)
    return { before: serializePatient(existing) }
  },
  async execute(rawInput, ctx) {
    const parsed = patientDeleteSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const locked = await lockPatient(em, parsed.id, scope)
    assertExpectedVersion(parsed.expectedUpdatedAt, locked.updatedAt, PATIENT_ENTITY_ID)

    const scopedChild = {
      patientId: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    }
    const [diagnoses, documentLinks, attachmentLinks] = await Promise.all([
      em.count(PatientDiagnosis, scopedChild as FilterQuery<PatientDiagnosis>),
      em.count(PatientDocumentLink, scopedChild as FilterQuery<PatientDocumentLink>),
      em.count(PatientAttachmentLink, scopedChild as FilterQuery<PatientAttachmentLink>),
    ])
    if (diagnoses > 0 || documentLinks > 0 || attachmentLinks > 0) {
      throw new CrudHttpError(409, {
        error: 'This record has documentation and cannot be deleted; archive it instead',
        code: 'patient_not_empty',
        counts: { diagnoses, documentLinks, attachmentLinks },
      })
    }

    const deletedAt = nextUpdatedAt(locked.updatedAt)
    let patient!: Patient

    await runCrudCommandWrite<Patient>({
      ctx,
      em,
      entityId: PATIENT_ENTITY_ID,
      action: 'deleted',
      scope,
      events: patientCrudEvents,
      indexer: patientCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        ({ em: phaseEm }) => {
          locked.deletedAt = deletedAt
          locked.updatedAt = deletedAt
          locked.updatedByUserId = actorUserId
          phaseEm.persist(locked)
          patient = locked
        },
        // Tombstone the addresses and contact links with the card. Leaving an active
        // primary address behind would keep occupying the partial unique index and block
        // a corrected record for the same person.
        async ({ em: phaseEm }) => {
          await phaseEm.nativeUpdate(
            PatientAddress,
            {
              patientId: parsed.id,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              deletedAt: null,
            } as FilterQuery<PatientAddress>,
            { deletedAt, updatedAt: deletedAt, updatedByUserId: actorUserId },
          )
        },
      ],
      sideEffect: () => ({
        entity: patient,
        identifiers: {
          id: String(patient.id),
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
      }),
    })

    return patient
  },
  buildLog: async ({ snapshots, result }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as SerializedPatient | undefined
    return {
      actionLabel: translate('patient.audit.patients.delete', 'Delete patient'),
      resourceKind: 'patient.patient',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
      snapshotBefore: before ?? null,
    }
  },
  /** Undo clears the tombstone on the record and the addresses it took with it. */
  async undo({ logEntry, ctx }) {
    const before = logEntry.snapshotBefore as SerializedPatient | undefined
    const id = before?.id ?? logEntry.resourceId
    if (!id) throw new Error('[internal] Missing patient id for undo')
    const scope = requirePatientScope(ctx)
    if (before && before.tenantId !== scope.tenantId) {
      throw new CrudHttpError(403, { error: 'Undo scope does not match tenant' })
    }
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const restoredAt = new Date()
    await em.nativeUpdate(
      Patient,
      { id, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<Patient>,
      { deletedAt: null, updatedAt: restoredAt, updatedByUserId: requireActorUserId(ctx) },
    )
    await em.nativeUpdate(
      PatientAddress,
      {
        patientId: id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      } as FilterQuery<PatientAddress>,
      { deletedAt: null, updatedAt: restoredAt, updatedByUserId: requireActorUserId(ctx) },
    )
  },
}

registerCommand(createPatientCommand)
registerCommand(updatePatientCommand)
registerCommand(archivePatientCommand)
registerCommand(deletePatientCommand)
