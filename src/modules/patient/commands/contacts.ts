import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEmitContext, CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { PatientContactLink } from '../data/entities'
import {
  patientContactCreateSchema,
  patientContactDeleteSchema,
  patientContactUpdateSchema,
} from '../data/validators'
import type { PatientReferenceService } from '../lib/patientReferenceService'
import {
  assertExpectedVersion,
  assertPatientAcceptsNewEntries,
  encryptSensitiveFields,
  lockPatient,
  nextUpdatedAt,
  requireActorUserId,
  requirePatientScope,
  toIsoTimestamp,
  tryResolveEncryptionService,
  type PatientScope,
} from '../lib/commandSupport'

const CONTACT_ENTITY_ID = 'patient:patient_contact_link' as const

export const patientContactCrudEvents: CrudEventsConfig<PatientContactLink> = {
  module: 'patient',
  entity: 'contact',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<PatientContactLink>) => ({
    id: ctx.identifiers.id,
    patientId: ctx.entity?.patientId ?? null,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    updatedAt: toIsoTimestamp(ctx.entity?.updatedAt),
  }),
}

export const patientContactCrudIndexer: CrudIndexerConfig<PatientContactLink> = {
  entityType: CONTACT_ENTITY_ID,
}

function referenceService(ctx: CommandRuntimeContext): PatientReferenceService {
  return ctx.container.resolve('patientReferenceService') as PatientReferenceService
}

async function loadContactDecrypted(
  em: EntityManager,
  id: string,
  scope: PatientScope,
): Promise<PatientContactLink> {
  const link = await findOneWithDecryption(
    em,
    PatientContactLink,
    {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientContactLink>,
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!link) throw new CrudHttpError(404, { error: 'Contact link not found' })
  return link
}

/** Clears the primary flag on whichever link currently holds it for this patient. */
async function demoteCurrentPrimaryContact(
  em: EntityManager,
  patientId: string,
  scope: PatientScope,
  exceptId: string | null,
  updatedAt: Date,
  actorUserId: string,
): Promise<void> {
  const where: Record<string, unknown> = {
    patientId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    isPrimaryContact: true,
    deletedAt: null,
  }
  if (exceptId) where.id = { $ne: exceptId }
  await em.nativeUpdate(PatientContactLink, where as FilterQuery<PatientContactLink>, {
    isPrimaryContact: false,
    updatedAt,
    updatedByUserId: actorUserId,
  })
}

/**
 * Links a CRM person to a patient.
 *
 * A patient may have zero contacts, and the same person may be linked to many patients —
 * a parent of two children in care is the obvious case. What is forbidden is two
 * *simultaneously active* links for the same pair, which the partial unique index
 * enforces and this command reports as a 409 rather than a constraint error.
 *
 * Re-linking a person who was previously unlinked creates a NEW row instead of reviving
 * the tombstoned one. The old link is a record of a relationship that existed during a
 * period of care; quietly resurrecting it would rewrite that history.
 *
 * Note the deliberate absence: nothing about the person is copied here. `requireActive…`
 * validates the reference, and the display name is resolved on read. A cached name would
 * be stale the moment CRM was edited, and would put identifying data in a second table.
 */
const createContactCommand: CommandHandler<Record<string, unknown>, PatientContactLink> = {
  id: 'patient.contacts.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientContactCreateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const patient = await lockPatient(em, parsed.patientId, scope)
    assertPatientAcceptsNewEntries(patient)

    // 422 when the id is not an active CRM person in this scope. Validating the reference
    // does not grant access to it: the picker that discovered the candidate called the
    // customers API and inherited its ACL.
    await referenceService(ctx).requireActiveCrmPerson(parsed.customerEntityId, scope)

    const alreadyLinked = await em.count(PatientContactLink, {
      patientId: parsed.patientId,
      customerEntityId: parsed.customerEntityId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientContactLink>)
    if (alreadyLinked > 0) {
      throw new CrudHttpError(409, {
        error: 'This person is already linked to this patient',
        code: 'contact_already_linked',
      })
    }

    const encrypted = await encryptSensitiveFields(
      CONTACT_ENTITY_ID,
      { relationshipLabel: parsed.relationshipLabel ?? null },
      scope,
      tryResolveEncryptionService(ctx),
    )

    const now = nextUpdatedAt(patient.updatedAt)
    let link!: PatientContactLink

    try {
      await runCrudCommandWrite<PatientContactLink>({
        ctx,
        em,
        entityId: CONTACT_ENTITY_ID,
        action: 'created',
        scope,
        events: patientContactCrudEvents,
        indexer: patientContactCrudIndexer,
        syncOrigin: ctx.syncOrigin,
        phases: [
          async ({ em: phaseEm }) => {
            if (parsed.isPrimaryContact) {
              await demoteCurrentPrimaryContact(phaseEm, parsed.patientId, scope, null, now, actorUserId)
            }
          },
          ({ em: phaseEm }) => {
            link = phaseEm.create(PatientContactLink, {
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              patientId: parsed.patientId,
              customerEntityId: parsed.customerEntityId,
              isGuardian: parsed.isGuardian,
              isContact: parsed.isContact,
              isPayer: parsed.isPayer,
              isPrimaryContact: parsed.isPrimaryContact,
              ...encrypted,
              createdAt: now,
              updatedAt: now,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
              deletedAt: null,
            })
            phaseEm.persist(link)
          },
          ({ em: phaseEm }) => {
            patient.updatedAt = now
            patient.updatedByUserId = actorUserId
            phaseEm.persist(patient)
          },
        ],
        sideEffect: () => ({
          entity: link,
          identifiers: {
            id: String(link.id),
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
          },
        }),
      })
    } catch (error) {
      // Two operators linking the same person at the same moment both pass the count
      // above and race on the partial unique index. The loser gets the same 409 the
      // sequential path produces, not a raw database error.
      if (error instanceof UniqueConstraintViolationException) {
        throw new CrudHttpError(409, {
          error: 'This person is already linked to this patient',
          code: 'contact_already_linked',
        })
      }
      throw error
    }

    return await loadContactDecrypted(em, String(link.id), scope)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.contacts.create', 'Link patient contact'),
      resourceKind: 'patient.patient_contact_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

/**
 * Updates the roles on an existing link.
 *
 * `customerEntityId` is not updatable. Re-pointing a link at a different person would
 * rewrite who is recorded as this patient's guardian while keeping the link's identity
 * and audit trail — which reads, afterwards, as though the new person had always been the
 * guardian. Changing who it is is an unlink plus a link, and both are audited.
 *
 * The role flags arrive as a complete set rather than a patch, so the "at least one role"
 * and "primary implies contact" invariants are checked against exactly what the operator
 * saw in the form.
 */
const updateContactCommand: CommandHandler<Record<string, unknown>, PatientContactLink> = {
  id: 'patient.contacts.update',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientContactUpdateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const preliminary = await em.findOne(PatientContactLink, {
      id: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientContactLink>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'Contact link not found' })

    const patient = await lockPatient(em, String(preliminary.patientId), scope)
    const link = await loadContactDecrypted(em, parsed.id, scope)
    assertExpectedVersion(parsed.expectedUpdatedAt, link.updatedAt, CONTACT_ENTITY_ID)

    const encrypted = await encryptSensitiveFields(
      CONTACT_ENTITY_ID,
      parsed.relationshipLabel !== undefined
        ? { relationshipLabel: parsed.relationshipLabel ?? null }
        : {},
      scope,
      tryResolveEncryptionService(ctx),
    )

    const promoting = parsed.isPrimaryContact && !link.isPrimaryContact
    const now = nextUpdatedAt(patient.updatedAt > link.updatedAt ? patient.updatedAt : link.updatedAt)

    await runCrudCommandWrite<PatientContactLink>({
      ctx,
      em,
      entityId: CONTACT_ENTITY_ID,
      action: 'updated',
      scope,
      events: patientContactCrudEvents,
      indexer: patientContactCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: phaseEm }) => {
          if (promoting) {
            await demoteCurrentPrimaryContact(
              phaseEm,
              String(link.patientId),
              scope,
              parsed.id,
              now,
              actorUserId,
            )
          }
        },
        ({ em: phaseEm }) => {
          link.isGuardian = parsed.isGuardian
          link.isContact = parsed.isContact
          link.isPayer = parsed.isPayer
          link.isPrimaryContact = parsed.isPrimaryContact
          if (parsed.relationshipLabel !== undefined) {
            link.relationshipLabel = (encrypted.relationshipLabel as string | null) ?? null
          }
          link.updatedAt = now
          link.updatedByUserId = actorUserId
          phaseEm.persist(link)
        },
        ({ em: phaseEm }) => {
          patient.updatedAt = now
          patient.updatedByUserId = actorUserId
          phaseEm.persist(patient)
        },
      ],
      sideEffect: () => ({
        entity: link,
        identifiers: {
          id: parsed.id,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
      }),
    })

    return await loadContactDecrypted(em, parsed.id, scope)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.contacts.update', 'Update patient contact'),
      resourceKind: 'patient.patient_contact_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

/**
 * Unlinks a contact.
 *
 * Soft delete of the LINK only. The CRM person is untouched — the spec is explicit that
 * unlinking must not cascade into customers — and a patient is allowed to end up with
 * zero contacts, so there is no "last contact" refusal to mirror the address rule.
 */
const deleteContactCommand: CommandHandler<Record<string, unknown>, PatientContactLink> = {
  id: 'patient.contacts.delete',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientContactDeleteSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const preliminary = await em.findOne(PatientContactLink, {
      id: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientContactLink>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'Contact link not found' })

    const patient = await lockPatient(em, String(preliminary.patientId), scope)
    const link = await em.findOne(PatientContactLink, {
      id: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientContactLink>)
    if (!link) throw new CrudHttpError(404, { error: 'Contact link not found' })
    assertExpectedVersion(parsed.expectedUpdatedAt, link.updatedAt, CONTACT_ENTITY_ID)

    const deletedAt = nextUpdatedAt(
      patient.updatedAt > link.updatedAt ? patient.updatedAt : link.updatedAt,
    )

    await runCrudCommandWrite<PatientContactLink>({
      ctx,
      em,
      entityId: CONTACT_ENTITY_ID,
      action: 'deleted',
      scope,
      events: patientContactCrudEvents,
      indexer: patientContactCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        ({ em: phaseEm }) => {
          link.deletedAt = deletedAt
          // Released with the link so the partial unique index does not keep treating a
          // tombstoned row as the patient's primary contact.
          link.isPrimaryContact = false
          link.updatedAt = deletedAt
          link.updatedByUserId = actorUserId
          phaseEm.persist(link)
        },
        ({ em: phaseEm }) => {
          patient.updatedAt = deletedAt
          patient.updatedByUserId = actorUserId
          phaseEm.persist(patient)
        },
      ],
      sideEffect: () => ({
        entity: link,
        identifiers: {
          id: parsed.id,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
      }),
    })

    return link
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.contacts.delete', 'Unlink patient contact'),
      resourceKind: 'patient.patient_contact_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

registerCommand(createContactCommand)
registerCommand(updateContactCommand)
registerCommand(deleteContactCommand)
