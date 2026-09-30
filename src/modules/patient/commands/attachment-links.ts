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
import { Patient, PatientAttachmentLink, PatientDiagnosis } from '../data/entities'
import {
  patientAttachmentLinkCreateSchema,
  patientAttachmentLinkDeleteSchema,
} from '../data/validators'
import { assertClinicalFilesAvailable } from '../lib/clinicalFileGate'
import {
  assertExpectedVersion,
  assertPatientAcceptsNewEntries,
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

const ATTACHMENT_LINK_ENTITY_ID = 'patient:patient_attachment_link' as const

/** Identifiers and scope only — never a file name. */
export const patientAttachmentLinkCrudEvents: CrudEventsConfig<PatientAttachmentLink> = {
  module: 'patient',
  entity: 'attachment_link',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<PatientAttachmentLink>) => ({
    id: ctx.identifiers.id,
    patientId: ctx.entity?.patientId ?? null,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    updatedAt: toIsoTimestamp(ctx.entity?.updatedAt),
  }),
}

export const patientAttachmentLinkCrudIndexer: CrudIndexerConfig<PatientAttachmentLink> = {
  entityType: ATTACHMENT_LINK_ENTITY_ID,
}

async function loadLinkDecrypted(
  em: EntityManager,
  id: string,
  scope: PatientScope,
): Promise<PatientAttachmentLink> {
  const link = await findOneWithDecryption(
    em,
    PatientAttachmentLink,
    {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientAttachmentLink>,
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!link) throw new CrudHttpError(404, { error: 'File link not found' })
  return link
}

/**
 * Links a stored file to a patient, or to one of that patient's diagnoses.
 *
 * **Gated on SEC-ATT.** The first thing this command does is refuse while the installed host
 * authorizes attachment downloads by scope alone — see `../lib/clinicalFileGate.ts`. Writing the
 * link would create a row that looks like protected clinical documentation while the bytes stay
 * readable by anyone in the organization who knows the attachment id.
 *
 * The gate is checked in the COMMAND, not only in the route, so every caller is covered: a CLI,
 * a future workflow, or another module reaching this through the command bus cannot bypass it by
 * not being an HTTP request.
 */
const createAttachmentLinkCommand: CommandHandler<Record<string, unknown>, PatientAttachmentLink> = {
  id: 'patient.attachment_links.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    assertClinicalFilesAvailable()

    const parsed = patientAttachmentLinkCreateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const digest = createRequestDigest({
      patientId: parsed.patientId,
      attachmentId: parsed.attachmentId,
      diagnosisId: parsed.diagnosisId ?? null,
    })

    const replayed = await em.findOne(PatientAttachmentLink, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      clientRequestId: parsed.clientRequestId,
    } as FilterQuery<PatientAttachmentLink>)
    if (replayed) {
      if (replayed.createRequestPayload !== digest) {
        throw new CrudHttpError(409, {
          error: 'This request id was already used with different content',
          code: 'idempotency_payload_mismatch',
        })
      }
      return await loadLinkDecrypted(em, String(replayed.id), scope)
    }

    const encrypted = await encryptSensitiveFields(
      ATTACHMENT_LINK_ENTITY_ID,
      { originalFileName: null },
      scope,
      tryResolveEncryptionService(ctx),
    )

    const linkId = randomUUID()
    let patient!: Patient
    let now!: Date
    let link!: PatientAttachmentLink

    try {
      await runCrudCommandWrite<PatientAttachmentLink>({
        ctx,
        em,
        entityId: ATTACHMENT_LINK_ENTITY_ID,
        action: 'created',
        scope,
        events: patientAttachmentLinkCrudEvents,
        indexer: patientAttachmentLinkCrudIndexer,
        syncOrigin: ctx.syncOrigin,
        phases: [
          async ({ em: phaseEm }) => {
            patient = await lockPatient(phaseEm, parsed.patientId, scope)
            assertPatientAcceptsNewEntries(patient)

            // A file may belong to the patient in general or to one diagnosis — and that
            // diagnosis must belong to THIS patient. Without the check, a caller could attach a
            // file to a diagnosis of someone else's record while naming a patient they can see.
            if (parsed.diagnosisId) {
              const diagnosis = await phaseEm.findOne(PatientDiagnosis, {
                id: parsed.diagnosisId,
                patientId: parsed.patientId,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
                deletedAt: null,
              } as FilterQuery<PatientDiagnosis>)
              if (!diagnosis) {
                throw new CrudHttpError(422, {
                  error: 'The referenced diagnosis does not belong to this patient',
                  code: 'diagnosis_not_of_patient',
                })
              }
            }

            now = nextUpdatedAt(patient.updatedAt)
          },
          ({ em: phaseEm }) => {
            link = phaseEm.create(PatientAttachmentLink, {
              id: linkId,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              patientId: parsed.patientId,
              attachmentId: parsed.attachmentId,
              diagnosisId: parsed.diagnosisId ?? null,
              state: 'active',
              ...encrypted,
              clientRequestId: parsed.clientRequestId,
              createRequestPayload: digest,
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
          identifiers: { id: linkId, tenantId: scope.tenantId, organizationId: scope.organizationId },
        }),
      })
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new CrudHttpError(409, {
          error: 'This file is already linked here',
          code: 'attachment_already_linked',
        })
      }
      throw error
    }

    return await loadLinkDecrypted(em, linkId, scope)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.attachmentLinks.create', 'Attach file to patient'),
      resourceKind: 'patient.patient_attachment_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

/**
 * Detaches a file.
 *
 * Soft-deletes the LINK and marks it `detached`. The stored file itself belongs to the
 * attachments module and is never removed from here — the spec forbids cascading into it, and a
 * file linked to both a patient and one of their diagnoses must survive one of those going away.
 *
 * Detaching is NOT gated on SEC-ATT. Removing a link can only ever narrow exposure, so refusing
 * it while the protection is missing would trap operators with links they cannot clear.
 */
const deleteAttachmentLinkCommand: CommandHandler<Record<string, unknown>, PatientAttachmentLink> = {
  id: 'patient.attachment_links.delete',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientAttachmentLinkDeleteSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const preliminary = await em.findOne(PatientAttachmentLink, {
      id: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientAttachmentLink>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'File link not found' })

    let patient!: Patient
    let link!: PatientAttachmentLink
    let deletedAt!: Date

    await runCrudCommandWrite<PatientAttachmentLink>({
      ctx,
      em,
      entityId: ATTACHMENT_LINK_ENTITY_ID,
      action: 'deleted',
      scope,
      events: patientAttachmentLinkCrudEvents,
      indexer: patientAttachmentLinkCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: phaseEm }) => {
          patient = await lockPatient(phaseEm, String(preliminary.patientId), scope)
          const found = await phaseEm.findOne(PatientAttachmentLink, {
            id: parsed.id,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            deletedAt: null,
          } as FilterQuery<PatientAttachmentLink>)
          if (!found) throw new CrudHttpError(404, { error: 'File link not found' })
          link = found
          assertExpectedVersion(parsed.expectedUpdatedAt, link.updatedAt, ATTACHMENT_LINK_ENTITY_ID)
          deletedAt = nextUpdatedAt(
            patient.updatedAt > link.updatedAt ? patient.updatedAt : link.updatedAt,
          )
        },
        ({ em: phaseEm }) => {
          // Both, deliberately: `state` records the domain fact for a reader of the history, and
          // `deleted_at` releases the partial unique index so the same file can be re-attached.
          link.state = 'detached'
          link.deletedAt = deletedAt
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
        identifiers: { id: parsed.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return link
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.attachmentLinks.delete', 'Detach file from patient'),
      resourceKind: 'patient.patient_attachment_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

registerCommand(createAttachmentLinkCommand)
registerCommand(deleteAttachmentLinkCommand)
