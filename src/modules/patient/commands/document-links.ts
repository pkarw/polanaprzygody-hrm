import { randomUUID } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { CommandBus, CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEmitContext, CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { hasTier, loadScopedDocument, resolveUserAccess } from '@open-mercato/documents/modules/documents/lib/permissions'
import { Patient, PatientDocumentLink } from '../data/entities'
import {
  patientDocumentLinkCreateSchema,
  patientDocumentLinkDeleteSchema,
  patientDocumentLinkNewSchema,
  patientDocumentLinkResumeSchema,
} from '../data/validators'
import { emitPatientEvent } from '../events'
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

const DOCUMENT_LINK_ENTITY_ID = 'patient:patient_document_link' as const

export const patientDocumentLinkCrudEvents: CrudEventsConfig<PatientDocumentLink> = {
  module: 'patient',
  entity: 'document_link',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<PatientDocumentLink>) => ({
    id: ctx.identifiers.id,
    patientId: ctx.entity?.patientId ?? null,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    updatedAt: toIsoTimestamp(ctx.entity?.updatedAt),
  }),
}

export const patientDocumentLinkCrudIndexer: CrudIndexerConfig<PatientDocumentLink> = {
  entityType: DOCUMENT_LINK_ENTITY_ID,
}

async function loadLinkDecrypted(
  em: EntityManager,
  id: string,
  scope: PatientScope,
): Promise<PatientDocumentLink> {
  const link = await findOneWithDecryption(
    em,
    PatientDocumentLink,
    {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientDocumentLink>,
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!link) throw new CrudHttpError(404, { error: 'Document link not found' })
  return link
}

/**
 * Requires that the caller can actually read the document under the documents module's OWN
 * policy.
 *
 * Pinning is not a grant. The spec is explicit: a document keeps its owner/share policy, and
 * reaching it through the patient card requires both this module's clinical feature and the
 * native document ACL. Without this check, `patient.clinical.manage` would become a way to
 * surface any document in the organization by id — and the link would then leak its title to
 * everyone who can read the patient card.
 *
 * 404 rather than 403 for a document the caller cannot see, so an id cannot be probed for
 * existence.
 */
async function requireDocumentReadAccess(
  em: EntityManager,
  documentId: string,
  scope: PatientScope,
  actorUserId: string,
  container: CommandRuntimeContext['container'],
): Promise<void> {
  const document = await loadScopedDocument(em, documentId, scope)
  if (!document) throw new CrudHttpError(404, { error: 'Document not found' })
  const tier = await resolveUserAccess(em, documentId, scope, actorUserId, container)
  if (!hasTier(tier, 'viewer')) {
    throw new CrudHttpError(404, { error: 'Document not found' })
  }
}

/**
 * Pins an EXISTING document to a patient.
 *
 * No share is created and none is implied. The UI warns before pinning that access is governed
 * by the document's own policy, because revoking `patient.clinical.view` later does not revoke
 * an independent share — the spec requires that semantics be stated rather than papered over.
 */
const createDocumentLinkCommand: CommandHandler<Record<string, unknown>, PatientDocumentLink> = {
  id: 'patient.document_links.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientDocumentLinkCreateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const digest = createRequestDigest({
      patientId: parsed.patientId,
      documentId: parsed.documentId,
    })

    const replayed = await em.findOne(PatientDocumentLink, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      clientRequestId: parsed.clientRequestId,
    } as FilterQuery<PatientDocumentLink>)
    if (replayed) {
      if (replayed.createRequestPayload !== digest) {
        throw new CrudHttpError(409, {
          error: 'This request id was already used with different content',
          code: 'idempotency_payload_mismatch',
        })
      }
      return await loadLinkDecrypted(em, String(replayed.id), scope)
    }

    // The document ACL check is a read and needs no patient lock, so it runs first and fails
    // fast without holding a row.
    await requireDocumentReadAccess(em, parsed.documentId, scope, actorUserId, ctx.container)

    const linkId = randomUUID()
    let patient!: Patient
    let now!: Date
    let link!: PatientDocumentLink

    try {
      await runCrudCommandWrite<PatientDocumentLink>({
        ctx,
        em,
        entityId: DOCUMENT_LINK_ENTITY_ID,
        action: 'created',
        scope,
        events: patientDocumentLinkCrudEvents,
        indexer: patientDocumentLinkCrudIndexer,
        syncOrigin: ctx.syncOrigin,
        phases: [
          async ({ em: phaseEm }) => {
            patient = await lockPatient(phaseEm, parsed.patientId, scope)
            assertPatientAcceptsNewEntries(patient)

            const alreadyLinked = await phaseEm.count(PatientDocumentLink, {
              patientId: parsed.patientId,
              documentId: parsed.documentId,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              deletedAt: null,
              state: { $ne: 'abandoned' },
            } as FilterQuery<PatientDocumentLink>)
            if (alreadyLinked > 0) {
              throw new CrudHttpError(409, {
                error: 'This document is already linked to this patient',
                code: 'document_already_linked',
              })
            }

            now = nextUpdatedAt(patient.updatedAt)
          },
          ({ em: phaseEm }) => {
            link = phaseEm.create(PatientDocumentLink, {
              id: linkId,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              patientId: parsed.patientId,
              documentId: parsed.documentId,
              state: 'linked',
              // Null for a pinned document: the content id and the working title belong to
              // the create-new intent, and this document already owns both.
              contentId: null,
              creationTitle: null,
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
          error: 'This document is already linked to this patient',
          code: 'document_already_linked',
        })
      }
      throw error
    }

    return await loadLinkDecrypted(em, linkId, scope)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.documentLinks.create', 'Pin document to patient'),
      resourceKind: 'patient.patient_document_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

/**
 * Activates a `pending_create` link once its document exists.
 *
 * Its own transaction, deliberately separate from the one that created the document. The
 * documents command emits its own post-write side effects and does not wait on an enclosing
 * transaction, so wrapping it would be a distributed transaction in appearance only — the
 * document would be committed while our rollback pretended it was not.
 *
 * `creation_title` is cleared here: from this point the document owns its title, and keeping a
 * copy would leave a second, stale one behind. The table's check constraint enforces that the
 * working title exists only while the state is `pending_create`.
 */
async function activatePendingLink(
  em: EntityManager,
  link: PatientDocumentLink,
  actorUserId: string,
): Promise<void> {
  await withAtomicFlush(
    em,
    [
      async () => {
        link.state = 'linked'
        link.creationTitle = null
        link.updatedAt = nextUpdatedAt(link.updatedAt)
        link.updatedByUserId = actorUserId
        em.persist(link)
      },
    ],
    { transaction: true, label: 'patient.document_links.activate' },
  )
}

/** The scope/title/id payload the documents module's own create command expects. */
function buildDocumentCreateInput(
  link: PatientDocumentLink,
  title: string,
  scope: PatientScope,
): Record<string, unknown> {
  return {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    documentId: link.documentId,
    contentId: link.contentId,
    title,
    folderId: null,
  }
}

/**
 * Creates a NEW document from the patient card, resumably.
 *
 * Three steps, in this order, and the order is the whole design:
 *
 * 1. **Our transaction** writes the intent: a link row in `pending_create` carrying the
 *    server-generated `document_id` and `content_id` and the encrypted working title.
 * 2. **The documents module's own command** creates the document with exactly those ids.
 * 3. **Our second transaction** flips the link to `linked` and drops the working title.
 *
 * A failure at step 2 or 3 leaves a visible `pending_create` row, which the UI offers to
 * resume. That is strictly better than the alternatives: creating the document first would
 * orphan it with nothing pointing at it, and wrapping step 2 in our transaction would be a
 * distributed transaction in name only, because the documents command's side effects do not
 * wait on our commit.
 *
 * Because the ids are fixed at step 1, a resume is idempotent by construction — it either finds
 * the document already there or creates it with the same ids, and can never produce a second
 * document.
 */
const createNewDocumentLinkCommand: CommandHandler<Record<string, unknown>, PatientDocumentLink> = {
  id: 'patient.document_links.create_document',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientDocumentLinkNewSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const digest = createRequestDigest({ patientId: parsed.patientId, title: parsed.title })

    // A repeated request resumes the SAME intent rather than starting a second one.
    const replayed = await em.findOne(PatientDocumentLink, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      clientRequestId: parsed.clientRequestId,
    } as FilterQuery<PatientDocumentLink>)
    if (replayed) {
      if (replayed.createRequestPayload !== digest) {
        throw new CrudHttpError(409, {
          error: 'This request id was already used with different content',
          code: 'idempotency_payload_mismatch',
        })
      }
      if (replayed.state === 'pending_create') {
        return await resumePendingLink(ctx, em, replayed, scope, actorUserId)
      }
      return await loadLinkDecrypted(em, String(replayed.id), scope)
    }

    const linkId = randomUUID()
    const documentId = randomUUID()
    const contentId = randomUUID()
    const encrypted = await encryptSensitiveFields(
      DOCUMENT_LINK_ENTITY_ID,
      { creationTitle: parsed.title },
      scope,
      tryResolveEncryptionService(ctx),
    )
    // Step 1 — the intent. Committed before the document exists, on purpose: a crash from here
    // on leaves something to resume rather than an orphaned document.
    //
    // The patient lock lives INSIDE this transaction: PESSIMISTIC_WRITE is only legal within an
    // open one, and the archived-record gate has to be read under it.
    let patient!: Patient
    let now!: Date
    let link!: PatientDocumentLink
    await withAtomicFlush(
      em,
      [
        async () => {
          patient = await lockPatient(em, parsed.patientId, scope)
          assertPatientAcceptsNewEntries(patient)
          now = nextUpdatedAt(patient.updatedAt)
        },
        async () => {
          link = em.create(PatientDocumentLink, {
            id: linkId,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            patientId: parsed.patientId,
            documentId,
            state: 'pending_create',
            contentId,
            ...encrypted,
            clientRequestId: parsed.clientRequestId,
            createRequestPayload: digest,
            createdAt: now,
            updatedAt: now,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
            deletedAt: null,
          })
          em.persist(link)
        },
        async () => {
          patient.updatedAt = now
          patient.updatedByUserId = actorUserId
          em.persist(patient)
        },
      ],
      { transaction: true, label: 'patient.document_links.intent' },
    )

    // Steps 2 and 3. A failure leaves the pending link for the UI to resume; the error is
    // rethrown so the caller learns the document is not ready.
    return await resumePendingLink(ctx, em, link, scope, actorUserId, parsed.title)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.documentLinks.createDocument', 'Create document for patient'),
      resourceKind: 'patient.patient_document_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

/**
 * Drives a `pending_create` link to `linked`, creating the document only if it is absent.
 *
 * Checking existence FIRST is what makes a retry safe: the documents create command answers an
 * already-existing document with a 409, so calling it blindly on resume would turn a
 * recoverable interruption into a permanent error. When the document is already there, its
 * scope and the caller's access are re-verified before the link is activated — a resume must
 * not become a way to attach a document the caller could not otherwise read.
 */
async function resumePendingLink(
  ctx: CommandRuntimeContext,
  em: EntityManager,
  link: PatientDocumentLink,
  scope: PatientScope,
  actorUserId: string,
  titleOverride?: string,
): Promise<PatientDocumentLink> {
  if (link.state === 'linked') return await loadLinkDecrypted(em, String(link.id), scope)
  if (link.state === 'abandoned') {
    throw new CrudHttpError(409, {
      error: 'This creation intent was abandoned',
      code: 'document_intent_abandoned',
    })
  }

  const existing = await loadScopedDocument(em, String(link.documentId), scope)
  if (existing) {
    await requireDocumentReadAccess(em, String(link.documentId), scope, actorUserId, ctx.container)
    await activatePendingLink(em, link, actorUserId)
    await emitPatientEvent('patient.document_link.updated', {
      id: String(link.id),
      patientId: String(link.patientId),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      updatedAt: new Date().toISOString(),
    })
    return await loadLinkDecrypted(em, String(link.id), scope)
  }

  // The working title is only readable from the link while the intent is pending. It is
  // decrypted by `loadLinkDecrypted`; `titleOverride` is the fresh value on the first attempt,
  // where the in-memory row still holds ciphertext.
  const title = titleOverride ?? (await loadLinkDecrypted(em, String(link.id), scope)).creationTitle
  if (!title) {
    throw new CrudHttpError(409, {
      error: 'This creation intent has no title to resume with',
      code: 'document_intent_incomplete',
    })
  }

  const commandBus = ctx.container.resolve('commandBus') as CommandBus
  // Deliberately NOT inside a transaction of ours: the documents command owns its own, and its
  // post-write side effects do not wait on an enclosing one.
  await commandBus.execute('documents.document.create', {
    input: buildDocumentCreateInput(link, title, scope),
    ctx,
  })

  await activatePendingLink(em, link, actorUserId)
  return await loadLinkDecrypted(em, String(link.id), scope)
}

/** Resumes an interrupted creation from the UI's "finish this" action. */
const resumeDocumentLinkCommand: CommandHandler<Record<string, unknown>, PatientDocumentLink> = {
  id: 'patient.document_links.resume',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = rawInput as Record<string, unknown>
    const id = typeof input.id === 'string' ? input.id : null
    if (!id) throw new CrudHttpError(400, { error: 'Document link id is required' })
    const parsed = patientDocumentLinkResumeSchema.parse(input)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const preliminary = await em.findOne(PatientDocumentLink, {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientDocumentLink>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'Document link not found' })

    // Resume composes its own multi-step flow (it may call the documents module's command), so
    // it takes the lock in an explicit transaction it owns rather than through
    // `runCrudCommandWrite`. The lock is released at commit, before the documents command runs.
    let link!: PatientDocumentLink
    await withAtomicFlush(
      em,
      [
        async () => {
          await lockPatient(em, String(preliminary.patientId), scope)
          link = await loadLinkDecrypted(em, id, scope)
          assertExpectedVersion(parsed.expectedUpdatedAt, link.updatedAt, DOCUMENT_LINK_ENTITY_ID)
        },
      ],
      { transaction: true, label: 'patient.document_links.resume.check' },
    )

    return await resumePendingLink(ctx, em, link, scope, actorUserId)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.documentLinks.resume', 'Resume document creation'),
      resourceKind: 'patient.patient_document_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

/**
 * Abandons an unfinished creation intent.
 *
 * Marks the link `abandoned` and drops the working title. If the document was in fact created
 * before the interruption, it stays with its owner — never deleted automatically, which the
 * spec states directly. Abandoning is a recorded decision, not a cleanup job.
 */
const abandonDocumentLinkCommand: CommandHandler<Record<string, unknown>, PatientDocumentLink> = {
  id: 'patient.document_links.abandon',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = rawInput as Record<string, unknown>
    const id = typeof input.id === 'string' ? input.id : null
    if (!id) throw new CrudHttpError(400, { error: 'Document link id is required' })
    const parsed = patientDocumentLinkResumeSchema.parse(input)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const preliminary = await em.findOne(PatientDocumentLink, {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientDocumentLink>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'Document link not found' })

    let patient!: Patient
    let link!: PatientDocumentLink
    let now!: Date

    await runCrudCommandWrite<PatientDocumentLink>({
      ctx,
      em,
      entityId: DOCUMENT_LINK_ENTITY_ID,
      action: 'updated',
      scope,
      events: patientDocumentLinkCrudEvents,
      indexer: patientDocumentLinkCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: phaseEm }) => {
          patient = await lockPatient(phaseEm, String(preliminary.patientId), scope)
          link = await loadLinkDecrypted(phaseEm, id, scope)
          assertExpectedVersion(parsed.expectedUpdatedAt, link.updatedAt, DOCUMENT_LINK_ENTITY_ID)

          if (link.state !== 'pending_create') {
            throw new CrudHttpError(409, {
              error: 'Only an unfinished creation intent can be abandoned',
              code: 'document_link_not_pending',
            })
          }

          now = nextUpdatedAt(
            patient.updatedAt > link.updatedAt ? patient.updatedAt : link.updatedAt,
          )
        },
        ({ em: phaseEm }) => {
          link.state = 'abandoned'
          // Required by the table's check constraint, which permits a working title only while
          // the state is `pending_create`.
          link.creationTitle = null
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
        identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    return link
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.documentLinks.abandon', 'Abandon document creation'),
      resourceKind: 'patient.patient_document_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

/**
 * Unpins a document.
 *
 * Soft-deletes the LINK. The document, its versions and its shares are untouched — the spec
 * forbids cascading into the documents module, and a document pinned to two patients must
 * survive being unpinned from one.
 */
const deleteDocumentLinkCommand: CommandHandler<Record<string, unknown>, PatientDocumentLink> = {
  id: 'patient.document_links.delete',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientDocumentLinkDeleteSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const preliminary = await em.findOne(PatientDocumentLink, {
      id: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientDocumentLink>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'Document link not found' })

    let patient!: Patient
    let link!: PatientDocumentLink
    let deletedAt!: Date

    await runCrudCommandWrite<PatientDocumentLink>({
      ctx,
      em,
      entityId: DOCUMENT_LINK_ENTITY_ID,
      action: 'deleted',
      scope,
      events: patientDocumentLinkCrudEvents,
      indexer: patientDocumentLinkCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: phaseEm }) => {
          patient = await lockPatient(phaseEm, String(preliminary.patientId), scope)
          const found = await phaseEm.findOne(PatientDocumentLink, {
            id: parsed.id,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            deletedAt: null,
          } as FilterQuery<PatientDocumentLink>)
          if (!found) throw new CrudHttpError(404, { error: 'Document link not found' })
          link = found
          assertExpectedVersion(parsed.expectedUpdatedAt, link.updatedAt, DOCUMENT_LINK_ENTITY_ID)

          // An unfinished intent blocks deleting the patient, and unpinning is not the way to
          // clear it: abandoning it is an explicit, audited decision about a document that may
          // exist.
          if (link.state === 'pending_create') {
            throw new CrudHttpError(409, {
              error: 'Finish or abandon this document creation before unpinning it',
              code: 'document_link_pending',
            })
          }

          deletedAt = nextUpdatedAt(
            patient.updatedAt > link.updatedAt ? patient.updatedAt : link.updatedAt,
          )
        },
        ({ em: phaseEm }) => {
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
      actionLabel: translate('patient.audit.documentLinks.delete', 'Unpin document from patient'),
      resourceKind: 'patient.patient_document_link',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

registerCommand(createDocumentLinkCommand)
registerCommand(createNewDocumentLinkCommand)
registerCommand(resumeDocumentLinkCommand)
registerCommand(abandonDocumentLinkCommand)
registerCommand(deleteDocumentLinkCommand)
