import { randomUUID } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEmitContext, CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { Patient, PatientDiagnosis } from '../data/entities'
import {
  patientDiagnosisCorrectSchema,
  patientDiagnosisCreateSchema,
  patientDiagnosisVoidSchema,
} from '../data/validators'
import { emitPatientEvent } from '../events'
import {
  assertExpectedVersion,
  assertPatientAcceptsNewEntries,
  createRequestDigest,
  encryptSensitiveFields,
  lockPatient,
  nextUpdatedAt,
  organizationToday,
  requireActorUserId,
  requirePatientScope,
  resolveClinicalTimeZone,
  toIsoTimestamp,
  tryResolveEncryptionService,
  type PatientScope,
} from '../lib/commandSupport'

const DIAGNOSIS_ENTITY_ID = 'patient:patient_diagnosis' as const

/** Identifiers, scope and version only — never a title, description or code. */
export const patientDiagnosisCrudEvents: CrudEventsConfig<PatientDiagnosis> = {
  module: 'patient',
  entity: 'diagnosis',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<PatientDiagnosis>) => ({
    id: ctx.identifiers.id,
    patientId: ctx.entity?.patientId ?? null,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    updatedAt: toIsoTimestamp(ctx.entity?.updatedAt),
  }),
}

export const patientDiagnosisCrudIndexer: CrudIndexerConfig<PatientDiagnosis> = {
  entityType: DIAGNOSIS_ENTITY_ID,
}

type DiagnosisContent = {
  title: string
  description: string
  diagnosedOn: string
  code?: string | null
  codeSystem?: string | null
  codeVersion?: string | null
}

async function loadDiagnosisDecrypted(
  em: EntityManager,
  id: string,
  scope: PatientScope,
): Promise<PatientDiagnosis> {
  const diagnosis = await findOneWithDecryption(
    em,
    PatientDiagnosis,
    {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientDiagnosis>,
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!diagnosis) throw new CrudHttpError(404, { error: 'Diagnosis not found' })
  return diagnosis
}

/**
 * Rejects a diagnosis date in the organization's future.
 *
 * A historical date is legitimate — an entry is often written up after the session — so only
 * the future is refused. The comparison is against the organization's local day rather than
 * UTC: near midnight those differ, and a clinician entering today's date at 01:00 local would
 * otherwise be told it is in the future.
 */
function assertDiagnosisDateNotInFuture(diagnosedOn: string): void {
  const today = organizationToday(resolveClinicalTimeZone())
  if (diagnosedOn > today) {
    throw new CrudHttpError(422, {
      error: 'A diagnosis cannot be dated in the future',
      code: 'diagnosed_on_in_future',
      today,
    })
  }
}

/** Encrypts the content columns, failing closed when protection is unavailable. */
async function encryptDiagnosisContent(
  content: DiagnosisContent,
  scope: PatientScope,
  encryption: ReturnType<typeof tryResolveEncryptionService>,
) {
  return encryptSensitiveFields(
    DIAGNOSIS_ENTITY_ID,
    {
      title: content.title,
      description: content.description,
      code: content.code ?? null,
      codeSystem: content.codeSystem ?? null,
      codeVersion: content.codeVersion ?? null,
    },
    scope,
    encryption,
  )
}

/**
 * Records a new diagnosis.
 *
 * The author is the authenticated user, never the payload: accepting a client-supplied author
 * would let anyone write clinical history under someone else's name. It is a user id rather
 * than a `team_member_id`, because the author is whoever actually wrote the entry.
 *
 * An archived record refuses a new entry. Correcting or voiding an existing one stays allowed
 * — that is the spec's distinction between adding to history and repairing it.
 */
const createDiagnosisCommand: CommandHandler<Record<string, unknown>, PatientDiagnosis> = {
  id: 'patient.diagnoses.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientDiagnosisCreateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const digest = createRequestDigest({
      patientId: parsed.patientId,
      title: parsed.title,
      description: parsed.description,
      diagnosedOn: parsed.diagnosedOn,
      code: parsed.code ?? null,
      codeSystem: parsed.codeSystem ?? null,
      codeVersion: parsed.codeVersion ?? null,
    })

    const replayed = await em.findOne(PatientDiagnosis, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      clientRequestId: parsed.clientRequestId,
    } as FilterQuery<PatientDiagnosis>)
    if (replayed) {
      if (replayed.createRequestPayload !== digest) {
        throw new CrudHttpError(409, {
          error: 'This request id was already used with different content',
          code: 'idempotency_payload_mismatch',
        })
      }
      return await loadDiagnosisDecrypted(em, String(replayed.id), scope)
    }

    // Date and content checks need no lock, so they run before the transaction opens and fail
    // fast; encryption is a KMS round trip that should not be held across a row lock either.
    assertDiagnosisDateNotInFuture(parsed.diagnosedOn)
    const columns = await encryptDiagnosisContent(parsed, scope, tryResolveEncryptionService(ctx))
    const diagnosisId = randomUUID()

    let patient!: Patient
    let now!: Date
    let diagnosis!: PatientDiagnosis

    try {
      await runCrudCommandWrite<PatientDiagnosis>({
        ctx,
        em,
        entityId: DIAGNOSIS_ENTITY_ID,
        action: 'created',
        scope,
        events: patientDiagnosisCrudEvents,
        indexer: patientDiagnosisCrudIndexer,
        syncOrigin: ctx.syncOrigin,
        phases: [
          // The lock, and the archived-record gate that depends on it, inside the transaction:
          // `PESSIMISTIC_WRITE` is only legal — and only meaningful — within one.
          async ({ em: phaseEm }) => {
            patient = await lockPatient(phaseEm, parsed.patientId, scope)
            assertPatientAcceptsNewEntries(patient)
            now = nextUpdatedAt(patient.updatedAt)
          },
          ({ em: phaseEm }) => {
            diagnosis = phaseEm.create(PatientDiagnosis, {
              id: diagnosisId,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              patientId: parsed.patientId,
              ...columns,
              diagnosedOn: parsed.diagnosedOn,
              authorUserId: actorUserId,
              supersedesId: null,
              status: 'active',
              voidReason: null,
              voidedAt: null,
              voidedByUserId: null,
              clientRequestId: parsed.clientRequestId,
              createRequestPayload: digest,
              createdAt: now,
              updatedAt: now,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
              deletedAt: null,
            })
            phaseEm.persist(diagnosis)
          },
          ({ em: phaseEm }) => {
            patient.updatedAt = now
            patient.updatedByUserId = actorUserId
            phaseEm.persist(patient)
          },
        ],
        sideEffect: () => ({
          entity: diagnosis,
          identifiers: {
            id: diagnosisId,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
          },
        }),
      })
    } catch (error) {
      // Two retries of the same request can both miss the read above and race the
      // `(scope, client_request_id)` unique index. The loser returns the winner's entry.
      if (error instanceof UniqueConstraintViolationException) {
        const raced = await (ctx.container.resolve('em') as EntityManager).fork().findOne(
          PatientDiagnosis,
          {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            clientRequestId: parsed.clientRequestId,
          } as FilterQuery<PatientDiagnosis>,
        )
        if (raced) return await loadDiagnosisDecrypted(em, String(raced.id), scope)
      }
      throw error
    }

    return await loadDiagnosisDecrypted(em, diagnosisId, scope)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.diagnoses.create', 'Record diagnosis'),
      resourceKind: 'patient.patient_diagnosis',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
      // No snapshot: the audit store would then hold a second copy of the clinical text, and
      // this command is not undoable — a diagnosis is repaired with `correct` or `void`, which
      // are explicit, authorized, recorded domain actions rather than a silent rollback.
    }
  },
}

/**
 * Corrects a diagnosis by superseding it.
 *
 * The original text is never rewritten. A new entry is inserted with `supersedes_id` pointing
 * at the old one, and the old one moves to `superseded`, in one transaction. Medical history
 * must not lose what was first recorded, which is also why this is not an update.
 *
 * Only the ACTIVE, LAST entry of a chain can be corrected. An already-superseded or voided
 * entry is a 409: correcting the middle of a chain would fork history into two competing
 * successors, and the partial unique index on `supersedes_id` would refuse it anyway — this
 * turns that into an error the clinician can act on.
 */
const correctDiagnosisCommand: CommandHandler<Record<string, unknown>, PatientDiagnosis> = {
  id: 'patient.diagnoses.correct',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = rawInput as Record<string, unknown>
    const id = typeof input.id === 'string' ? input.id : null
    if (!id) throw new CrudHttpError(400, { error: 'Diagnosis id is required' })
    const parsed = patientDiagnosisCorrectSchema.parse(input)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const preliminary = await em.findOne(PatientDiagnosis, {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientDiagnosis>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'Diagnosis not found' })

    // Idempotent retry: a repeated correction returns the successor it already created.
    const digest = createRequestDigest({
      supersedesId: id,
      title: parsed.title,
      description: parsed.description,
      diagnosedOn: parsed.diagnosedOn,
      code: parsed.code ?? null,
      codeSystem: parsed.codeSystem ?? null,
      codeVersion: parsed.codeVersion ?? null,
    })
    const replayed = await em.findOne(PatientDiagnosis, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      clientRequestId: parsed.clientRequestId,
    } as FilterQuery<PatientDiagnosis>)
    if (replayed) {
      if (replayed.createRequestPayload !== digest) {
        throw new CrudHttpError(409, {
          error: 'This request id was already used with different content',
          code: 'idempotency_payload_mismatch',
        })
      }
      return await loadDiagnosisDecrypted(em, String(replayed.id), scope)
    }

    assertDiagnosisDateNotInFuture(parsed.diagnosedOn)

    const columns = await encryptDiagnosisContent(parsed, scope, tryResolveEncryptionService(ctx))
    const successorId = randomUUID()

    let patient!: Patient
    let previous!: PatientDiagnosis
    let now!: Date
    let successor!: PatientDiagnosis

    try {
      await runCrudCommandWrite<PatientDiagnosis>({
        ctx,
        em,
        entityId: DIAGNOSIS_ENTITY_ID,
        action: 'created',
        scope,
        // The dedicated `corrected` event is emitted below instead of the generic `created`,
        // so one state change is published once.
        indexer: patientDiagnosisCrudIndexer,
        syncOrigin: ctx.syncOrigin,
        phases: [
          // Patient first, then the entry — the same lock order every command here uses, and
          // inside the transaction so the chain check and the version check are serialized
          // against a concurrent correction rather than racing it.
          async ({ em: phaseEm }) => {
            patient = await lockPatient(phaseEm, String(preliminary.patientId), scope)
            previous = await loadDiagnosisDecrypted(phaseEm, id, scope)
            assertExpectedVersion(parsed.expectedUpdatedAt, previous.updatedAt, DIAGNOSIS_ENTITY_ID)

            if (previous.status !== 'active') {
              throw new CrudHttpError(409, {
                error:
                  previous.status === 'voided'
                    ? 'A voided entry cannot be corrected'
                    : 'This entry has already been corrected; correct the latest entry instead',
                code: 'diagnosis_not_correctable',
                status: previous.status,
              })
            }

            now = nextUpdatedAt(
              patient.updatedAt > previous.updatedAt ? patient.updatedAt : previous.updatedAt,
            )
          },
          ({ em: phaseEm }) => {
            successor = phaseEm.create(PatientDiagnosis, {
              id: successorId,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              patientId: previous.patientId,
              ...columns,
              diagnosedOn: parsed.diagnosedOn,
              // The corrector is the author of the correction. The original entry keeps its
              // own author, so the chain records who wrote what.
              authorUserId: actorUserId,
              supersedesId: id,
              status: 'active',
              voidReason: null,
              voidedAt: null,
              voidedByUserId: null,
              clientRequestId: parsed.clientRequestId,
              createRequestPayload: digest,
              createdAt: now,
              updatedAt: now,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
              deletedAt: null,
            })
            phaseEm.persist(successor)
          },
          ({ em: phaseEm }) => {
            // The original keeps its title, description, date, code and author untouched.
            // Only its status changes.
            previous.status = 'superseded'
            previous.updatedAt = now
            previous.updatedByUserId = actorUserId
            phaseEm.persist(previous)
          },
          ({ em: phaseEm }) => {
            patient.updatedAt = now
            patient.updatedByUserId = actorUserId
            phaseEm.persist(patient)
          },
        ],
        sideEffect: () => ({
          entity: successor,
          identifiers: {
            id: successorId,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
          },
        }),
      })
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        // Either a retry raced on the request id, or two clinicians corrected the same entry
        // at once and lost the single-successor index. Both must read as a conflict rather
        // than a database error.
        const raced = await (ctx.container.resolve('em') as EntityManager).fork().findOne(
          PatientDiagnosis,
          {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            clientRequestId: parsed.clientRequestId,
          } as FilterQuery<PatientDiagnosis>,
        )
        if (raced) return await loadDiagnosisDecrypted(em, String(raced.id), scope)
        throw new CrudHttpError(409, {
          error: 'This entry was corrected by someone else; reload the history',
          code: 'diagnosis_already_corrected',
        })
      }
      throw error
    }

    await emitPatientEvent('patient.diagnosis.corrected', {
      id: successorId,
      patientId: String(previous.patientId),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      updatedAt: now.toISOString(),
    })

    return await loadDiagnosisDecrypted(em, successorId, scope)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.diagnoses.correct', 'Correct diagnosis'),
      resourceKind: 'patient.patient_diagnosis',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

/**
 * Voids a diagnosis.
 *
 * A reason is required and stored encrypted, and the timestamp and actor are server-side. The
 * text is kept: voiding says "this entry should not have been recorded", not "this entry never
 * existed", and the spec forbids destroying clinical history.
 *
 * Allowed on an archived record, because it repairs history rather than adding to it.
 */
const voidDiagnosisCommand: CommandHandler<Record<string, unknown>, PatientDiagnosis> = {
  id: 'patient.diagnoses.void',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = rawInput as Record<string, unknown>
    const id = typeof input.id === 'string' ? input.id : null
    if (!id) throw new CrudHttpError(400, { error: 'Diagnosis id is required' })
    const parsed = patientDiagnosisVoidSchema.parse(input)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const preliminary = await em.findOne(PatientDiagnosis, {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientDiagnosis>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'Diagnosis not found' })

    const encrypted = await encryptSensitiveFields(
      DIAGNOSIS_ENTITY_ID,
      { voidReason: parsed.reason },
      scope,
      tryResolveEncryptionService(ctx),
    )

    let patient!: Patient
    let diagnosis!: PatientDiagnosis
    let now!: Date

    await runCrudCommandWrite<PatientDiagnosis>({
      ctx,
      em,
      entityId: DIAGNOSIS_ENTITY_ID,
      action: 'updated',
      scope,
      indexer: patientDiagnosisCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: phaseEm }) => {
          patient = await lockPatient(phaseEm, String(preliminary.patientId), scope)
          diagnosis = await loadDiagnosisDecrypted(phaseEm, id, scope)
          assertExpectedVersion(parsed.expectedUpdatedAt, diagnosis.updatedAt, DIAGNOSIS_ENTITY_ID)

          if (diagnosis.status === 'voided') {
            throw new CrudHttpError(409, {
              error: 'This entry is already voided',
              code: 'diagnosis_already_voided',
            })
          }

          now = nextUpdatedAt(
            patient.updatedAt > diagnosis.updatedAt ? patient.updatedAt : diagnosis.updatedAt,
          )
        },
        ({ em: phaseEm }) => {
          // Status, reason, timestamp and actor move together — the table's check constraint
          // requires all four to agree, so a partial write is impossible by construction.
          diagnosis.status = 'voided'
          diagnosis.voidReason = (encrypted.voidReason as string | null) ?? null
          diagnosis.voidedAt = now
          diagnosis.voidedByUserId = actorUserId
          diagnosis.updatedAt = now
          diagnosis.updatedByUserId = actorUserId
          phaseEm.persist(diagnosis)
        },
        ({ em: phaseEm }) => {
          patient.updatedAt = now
          patient.updatedByUserId = actorUserId
          phaseEm.persist(patient)
        },
      ],
      sideEffect: () => ({
        entity: diagnosis,
        identifiers: {
          id,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
      }),
    })

    await emitPatientEvent('patient.diagnosis.voided', {
      id,
      patientId: String(diagnosis.patientId),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      updatedAt: now.toISOString(),
    })

    return await loadDiagnosisDecrypted(em, id, scope)
  },
  buildLog: async ({ result, input }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.diagnoses.void', 'Void diagnosis'),
      resourceKind: 'patient.patient_diagnosis',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
      // The reason is deliberately NOT copied into `changes`: the action log's storage is not
      // guaranteed to protect free text, and the reason is already on the record in an
      // encrypted column. Recording that a void happened, by whom and when is the audit's job.
      changes: { status: { from: 'active', to: 'voided' }, reasonProvided: Boolean((input as { reason?: string }).reason) },
    }
  },
}

registerCommand(createDiagnosisCommand)
registerCommand(correctDiagnosisCommand)
registerCommand(voidDiagnosisCommand)
