import { randomUUID } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { conflict, CrudHttpError, forbidden } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEmitContext, CrudEventsConfig } from '@open-mercato/shared/lib/crud/types'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { Patient, PatientVisit, PatientVisitService, type PatientVisitStatus } from '../data/entities'
import {
  patientVisitCreateSchema,
  patientVisitConfirmationActionSchema,
  patientVisitDeleteSchema,
  patientVisitInstantMatchesTimeZone,
  patientVisitSettleSchema,
  patientVisitTransitionSchema,
  patientVisitUnsettleSchema,
  patientVisitUpdateSchema,
} from '../data/validators'
import { emitPatientEvent } from '../events'
import type {
  PatientReferenceService,
  ResolvedProductReference,
  ResolvedReference,
} from '../lib/patientReferenceService'
import {
  assertExpectedVersion,
  assertPatientAcceptsNewEntries,
  createRequestDigest,
  encryptSensitiveFields,
  isLockWaitTimeout,
  lockPatient,
  nextUpdatedAt,
  requireActorUserId,
  requirePatientScope,
  toIsoTimestamp,
  tryResolveEncryptionService,
  type PatientScope,
} from '../lib/commandSupport'

const VISIT_ENTITY_ID = 'patient:patient_visit' as const
const VISIT_SERVICE_ENTITY_ID = 'patient:patient_visit_service' as const

type ScopedRbacService = {
  userHasAllFeatures(
    userId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ): Promise<boolean>
}

type VisitServiceSnapshot = {
  id: string
  productId: string
  title: string
  sku: string | null
  position: number
}

type VisitAuditSnapshot = {
  id: string
  patientId: string
  teamMemberId: string
  teamMemberNameSnapshot: string
  resourceId: string | null
  resourceNameSnapshot: string | null
  startsAt: string
  endsAt: string | null
  timeZone: string
  description: string | null
  status: string
  statusReason: string | null
  statusChangedAt: string
  statusChangedByUserId: string
  isSettled: boolean
  settledAt: string | null
  settledByUserId: string | null
  settlementReason: string | null
  confirmedAt: string | null
  confirmedByUserId: string | null
  services: VisitServiceSnapshot[]
  updatedAt: string
  tenantId: string
  organizationId: string
}

export const patientVisitCrudEvents: CrudEventsConfig<PatientVisit> = {
  module: 'patient',
  entity: 'visit',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<PatientVisit>) => ({
    id: ctx.identifiers.id,
    patientId: ctx.entity?.patientId ?? null,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    updatedAt: toIsoTimestamp(ctx.entity?.updatedAt),
  }),
}

function referenceService(ctx: CommandRuntimeContext): PatientReferenceService {
  try {
    return ctx.container.resolve('patientReferenceService') as PatientReferenceService
  } catch {
    throw new CrudHttpError(503, {
      error: 'The reference service required for patient visits is unavailable',
      code: 'visit_reference_service_unavailable',
    })
  }
}

async function requireReferenceFeature(
  ctx: CommandRuntimeContext,
  scope: PatientScope,
  feature: string,
): Promise<void> {
  const userId = requireActorUserId(ctx)
  let rbac: ScopedRbacService
  try {
    rbac = ctx.container.resolve('rbacService') as ScopedRbacService
  } catch {
    throw new CrudHttpError(503, {
      error: 'The authorization service required for visit references is unavailable',
      code: 'visit_reference_authorization_unavailable',
    })
  }
  if (!(await rbac.userHasAllFeatures(userId, [feature], scope))) {
    throw new CrudHttpError(403, {
      error: 'You do not have access to the referenced records',
      code: 'visit_reference_forbidden',
      feature,
    })
  }
}

async function loadVisitDecrypted(
  em: EntityManager,
  id: string,
  scope: PatientScope,
): Promise<PatientVisit> {
  const visit = await findOneWithDecryption(
    em,
    PatientVisit,
    {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientVisit>,
    undefined,
    scope,
  )
  if (!visit) throw new CrudHttpError(404, { error: 'Visit not found' })
  return visit
}

/** Called only after `lockPatient`, so its transaction-local lock timeout is already active. */
async function lockVisit(
  em: EntityManager,
  id: string,
  scope: PatientScope,
  options?: { includeDeleted?: boolean },
): Promise<PatientVisit> {
  let visit: PatientVisit | null
  try {
    const where: FilterQuery<PatientVisit> = {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }
    if (!options?.includeDeleted) where.deletedAt = null
    visit = await em.findOne(
      PatientVisit,
      where,
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
  } catch (error) {
    if (isLockWaitTimeout(error)) {
      throw new CrudHttpError(409, {
        error: 'This visit is being changed right now; try again in a moment',
        code: 'visit_locked',
      })
    }
    throw error
  }
  if (!visit) throw new CrudHttpError(404, { error: 'Visit not found' })
  return visit
}

async function loadVisitServicesDecrypted(
  em: EntityManager,
  visitId: string,
  scope: PatientScope,
): Promise<PatientVisitService[]> {
  return await findWithDecryption(
    em,
    PatientVisitService,
    {
      visitId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientVisitService>,
    { orderBy: { position: 'asc' } },
    scope,
  )
}

async function serializeVisit(
  em: EntityManager,
  visit: PatientVisit,
  scope: PatientScope,
): Promise<VisitAuditSnapshot> {
  const services = await loadVisitServicesDecrypted(em, String(visit.id), scope)
  return {
    id: String(visit.id),
    patientId: String(visit.patientId),
    teamMemberId: String(visit.teamMemberId),
    teamMemberNameSnapshot: String(visit.teamMemberNameSnapshot),
    resourceId: visit.resourceId ?? null,
    resourceNameSnapshot: visit.resourceNameSnapshot ?? null,
    startsAt: visit.startsAt.toISOString(),
    endsAt: visit.endsAt?.toISOString() ?? null,
    timeZone: String(visit.timeZone),
    description: visit.description ?? null,
    status: String(visit.status),
    statusReason: visit.statusReason ?? null,
    statusChangedAt: visit.statusChangedAt.toISOString(),
    statusChangedByUserId: String(visit.statusChangedByUserId),
    isSettled: Boolean(visit.isSettled),
    settledAt: visit.settledAt?.toISOString() ?? null,
    settledByUserId: visit.settledByUserId ?? null,
    settlementReason: visit.settlementReason ?? null,
    confirmedAt: visit.confirmedAt?.toISOString() ?? null,
    confirmedByUserId: visit.confirmedByUserId ?? null,
    services: services.map((service) => ({
      id: String(service.id),
      productId: String(service.productId),
      title: String(service.productTitleSnapshot),
      sku: service.productSkuSnapshot ?? null,
      position: Number(service.position),
    })),
    updatedAt: visit.updatedAt.toISOString(),
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  }
}

function assertSchedule(startsAt: Date, endsAt: Date | null): void {
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new CrudHttpError(422, {
      error: 'The visit end must be later than its start',
      code: 'visit_end_not_after_start',
    })
  }
}

function assertUniqueServiceProductIds(productIds: string[]): void {
  if (new Set(productIds).size !== productIds.length) {
    throw new CrudHttpError(409, {
      error: 'The same service cannot be selected twice',
      code: 'visit_service_duplicate',
    })
  }
}

function assertScheduleTimeZone(startsAt: string | undefined, endsAt: string | null | undefined, timeZone: string): void {
  if (
    (startsAt !== undefined && !patientVisitInstantMatchesTimeZone(startsAt, timeZone)) ||
    (endsAt !== undefined && endsAt !== null && !patientVisitInstantMatchesTimeZone(endsAt, timeZone))
  ) {
    throw new CrudHttpError(422, {
      error: 'The visit time and explicit offset must exist in the selected time zone',
      code: 'visit_time_zone_mismatch',
    })
  }
}

function storedInstantAtTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  const localAsUtc = Date.UTC(
    Number(byType.get('year')),
    Number(byType.get('month')) - 1,
    Number(byType.get('day')),
    Number(byType.get('hour')),
    Number(byType.get('minute')),
    Number(byType.get('second')),
    instant.getUTCMilliseconds(),
  )
  const offsetMinutes = Math.round((localAsUtc - instant.getTime()) / 60_000)
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 14 * 60) {
    throw new CrudHttpError(422, {
      error: 'The stored visit instant cannot be represented in the selected time zone',
      code: 'visit_time_zone_mismatch',
    })
  }
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`
  const fraction = instant.getUTCMilliseconds() === 0
    ? ''
    : `.${String(instant.getUTCMilliseconds()).padStart(3, '0')}`
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}T${byType.get('hour')}:${byType.get('minute')}:${byType.get('second')}${fraction}${offset}`
}

function assertVisitEditable(visit: PatientVisit): void {
  if (visit.status !== 'planned') {
    throw new CrudHttpError(409, {
      error: 'A closed visit must be reopened before it can be edited',
      code: 'visit_not_editable',
    })
  }
}

function assertVisitDeletable(visit: PatientVisit): void {
  if (visit.status !== 'planned' || visit.isSettled) {
    throw new CrudHttpError(409, {
      error: 'Only a planned, unsettled visit can be deleted',
      code: 'visit_not_deletable',
    })
  }
}

async function resolveCreateReferences(
  ctx: CommandRuntimeContext,
  scope: PatientScope,
  input: { teamMemberId: string; resourceId?: string | null; serviceProductIds: string[] },
): Promise<{
  teamMember: ResolvedReference
  resource: ResolvedReference | null
  products: ResolvedProductReference[]
}> {
  const references = referenceService(ctx)
  const teamMember = await references.requireActiveTeamMember(input.teamMemberId, scope)

  let resource: ResolvedReference | null = null
  if (input.resourceId) {
    resource = await references.requireActiveResource(input.resourceId, scope)
  }

  let products: ResolvedProductReference[] = []
  if (input.serviceProductIds.length > 0) {
    products = await references.requireActiveProducts(input.serviceProductIds, scope)
  }
  return { teamMember, resource, products }
}

async function requireCreateReferenceFeatures(
  ctx: CommandRuntimeContext,
  scope: PatientScope,
  input: { resourceId?: string | null; serviceProductIds: string[] },
): Promise<void> {
  await requireReferenceFeature(ctx, scope, 'staff.view')
  if (input.resourceId) await requireReferenceFeature(ctx, scope, 'resources.view')
  if (input.serviceProductIds.length > 0) {
    await requireReferenceFeature(ctx, scope, 'catalog.products.view')
  }
}

async function encryptServiceSnapshots(
  products: ResolvedProductReference[],
  scope: PatientScope,
  encryption: ReturnType<typeof tryResolveEncryptionService>,
): Promise<Map<string, { productTitleSnapshot: string; productSkuSnapshot: string | null }>> {
  const result = new Map<string, { productTitleSnapshot: string; productSkuSnapshot: string | null }>()
  for (const product of products) {
    const columns = await encryptSensitiveFields(
      VISIT_SERVICE_ENTITY_ID,
      {
        productTitleSnapshot: product.displayName,
        productSkuSnapshot: product.sku,
      },
      scope,
      encryption,
    )
    result.set(product.id, columns)
  }
  return result
}

function requireUndoSnapshot(
  value: unknown,
  scope: PatientScope,
  kind: 'before' | 'after',
): VisitAuditSnapshot {
  const snapshot = value as VisitAuditSnapshot | null | undefined
  if (!snapshot?.id || !snapshot.patientId) {
    throw new Error(`[internal] Missing visit ${kind} snapshot for undo`)
  }
  if (snapshot.tenantId !== scope.tenantId || snapshot.organizationId !== scope.organizationId) {
    throw new CrudHttpError(403, { error: 'Undo scope does not match the visit scope' })
  }
  return snapshot
}

async function authorizeSnapshotReferences(
  ctx: CommandRuntimeContext,
  scope: PatientScope,
  snapshot: VisitAuditSnapshot,
): Promise<void> {
  await requireReferenceFeature(ctx, scope, 'patient.visits.manage')
  await requireReferenceFeature(ctx, scope, 'staff.view')
  const references = referenceService(ctx)
  await references.requireActiveTeamMember(snapshot.teamMemberId, scope)
  if (snapshot.resourceId) {
    await requireReferenceFeature(ctx, scope, 'resources.view')
    await references.requireActiveResource(snapshot.resourceId, scope)
  }
  if (snapshot.services.length > 0) {
    await requireReferenceFeature(ctx, scope, 'catalog.products.view')
    await references.requireActiveProducts(snapshot.services.map((service) => service.productId), scope)
  }
}

async function encryptVisitSnapshot(
  snapshot: VisitAuditSnapshot,
  scope: PatientScope,
  encryption: ReturnType<typeof tryResolveEncryptionService>,
): Promise<Record<string, unknown>> {
  return await encryptSensitiveFields(
    VISIT_ENTITY_ID,
    {
      teamMemberNameSnapshot: snapshot.teamMemberNameSnapshot,
      resourceNameSnapshot: snapshot.resourceNameSnapshot,
      description: snapshot.description,
      statusReason: snapshot.statusReason,
      settlementReason: snapshot.settlementReason,
    },
    scope,
    encryption,
  )
}

function restoreVisitHeader(
  visit: PatientVisit,
  snapshot: VisitAuditSnapshot,
  encrypted: Record<string, unknown>,
  updatedAt: Date,
  actorUserId: string,
): void {
  visit.teamMemberId = snapshot.teamMemberId
  visit.teamMemberNameSnapshot = String(encrypted.teamMemberNameSnapshot)
  visit.resourceId = snapshot.resourceId
  visit.resourceNameSnapshot = (encrypted.resourceNameSnapshot as string | null) ?? null
  visit.startsAt = new Date(snapshot.startsAt)
  visit.endsAt = snapshot.endsAt ? new Date(snapshot.endsAt) : null
  visit.timeZone = snapshot.timeZone
  visit.description = (encrypted.description as string | null) ?? null
  visit.status = snapshot.status as PatientVisitStatus
  visit.statusReason = (encrypted.statusReason as string | null) ?? null
  visit.statusChangedAt = new Date(snapshot.statusChangedAt)
  visit.statusChangedByUserId = snapshot.statusChangedByUserId
  visit.isSettled = snapshot.isSettled
  visit.settledAt = snapshot.settledAt ? new Date(snapshot.settledAt) : null
  visit.settledByUserId = snapshot.settledByUserId
  visit.settlementReason = (encrypted.settlementReason as string | null) ?? null
  visit.confirmedAt = snapshot.confirmedAt ? new Date(snapshot.confirmedAt) : null
  visit.confirmedByUserId = snapshot.confirmedByUserId
  visit.deletedAt = null
  visit.updatedAt = updatedAt
  visit.updatedByUserId = actorUserId
}

async function restoreVisitServices(
  em: EntityManager,
  snapshot: VisitAuditSnapshot,
  scope: PatientScope,
  actorUserId: string,
  updatedAt: Date,
  encryptedSnapshots: Map<string, { productTitleSnapshot: string; productSkuSnapshot: string | null }>,
): Promise<void> {
  await em.nativeUpdate(
    PatientVisitService,
    {
      visitId: snapshot.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientVisitService>,
    { deletedAt: updatedAt, updatedAt, updatedByUserId: actorUserId },
  )
  for (const service of snapshot.services) {
    const columns = encryptedSnapshots.get(service.productId)
    if (!columns) throw new Error('[internal] Missing encrypted service snapshot for undo')
    em.persist(em.create(PatientVisitService, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      visitId: snapshot.id,
      productId: service.productId,
      ...columns,
      position: service.position,
      createdAt: updatedAt,
      updatedAt,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      deletedAt: null,
    }))
  }
}

async function emitUndoVisitEvent(
  eventId: 'patient.visit.created' | 'patient.visit.updated' | 'patient.visit.deleted',
  snapshot: VisitAuditSnapshot,
  updatedAt: Date,
): Promise<void> {
  await emitPatientEvent(eventId, {
    id: snapshot.id,
    patientId: snapshot.patientId,
    tenantId: snapshot.tenantId,
    organizationId: snapshot.organizationId,
    updatedAt: updatedAt.toISOString(),
  })
}

async function resolveIdempotentVisit(
  em: EntityManager,
  clientRequestId: string,
  digest: string,
  scope: PatientScope,
): Promise<PatientVisit | null> {
  const found = await em.findOne(PatientVisit, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    clientRequestId,
  } as FilterQuery<PatientVisit>)
  if (!found) return null
  const existing = await findOneWithDecryption(
    em,
    PatientVisit,
    {
      id: String(found.id),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    } as FilterQuery<PatientVisit>,
    undefined,
    scope,
  )
  if (!existing) return null
  if (existing.createRequestPayload !== digest) {
    throw new CrudHttpError(409, {
      error: 'This request id was already used with different content',
      code: 'idempotency_payload_mismatch',
    })
  }
  if (existing.deletedAt) {
    throw new CrudHttpError(409, {
      error: 'This request id belongs to a visit that was deleted',
      code: 'idempotency_record_deleted',
    })
  }
  return existing
}

const createVisitCommand: CommandHandler<Record<string, unknown>, PatientVisit> = {
  id: 'patient.visits.create',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const parsed = patientVisitCreateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    assertUniqueServiceProductIds(parsed.serviceProductIds)
    const startsAt = new Date(parsed.startsAt)
    const endsAt = parsed.endsAt ? new Date(parsed.endsAt) : null
    assertSchedule(startsAt, endsAt)
    assertScheduleTimeZone(parsed.startsAt, parsed.endsAt, parsed.timeZone)

    const digest = createRequestDigest({
      patientId: parsed.patientId,
      teamMemberId: parsed.teamMemberId,
      resourceId: parsed.resourceId ?? null,
      startsAt: new Date(parsed.startsAt).toISOString(),
      endsAt: parsed.endsAt ? new Date(parsed.endsAt).toISOString() : null,
      timeZone: parsed.timeZone,
      description: parsed.description ?? null,
      serviceProductIds: parsed.serviceProductIds,
    })
    // A retry is still a current request. Re-check host visibility before returning the
    // historical result, but do not require the historical references to remain active.
    await requireCreateReferenceFeatures(ctx, scope, parsed)
    const replayed = await resolveIdempotentVisit(em, parsed.clientRequestId, digest, scope)
    if (replayed) return replayed

    const resolved = await resolveCreateReferences(ctx, scope, parsed)
    const encryption = tryResolveEncryptionService(ctx)
    const visitColumns = await encryptSensitiveFields(
      VISIT_ENTITY_ID,
      {
        teamMemberNameSnapshot: resolved.teamMember.displayName,
        resourceNameSnapshot: resolved.resource?.displayName ?? null,
        description: parsed.description ?? null,
        statusReason: null,
        settlementReason: null,
        createRequestPayload: digest,
      },
      scope,
      encryption,
    )
    const serviceColumns = await encryptServiceSnapshots(resolved.products, scope, encryption)
    const visitId = randomUUID()
    let patient!: Patient
    let visit!: PatientVisit
    let now!: Date
    try {
      await runCrudCommandWrite<PatientVisit>({
        ctx,
        em,
        entityId: VISIT_ENTITY_ID,
        action: 'created',
        scope,
        events: patientVisitCrudEvents,
        syncOrigin: ctx.syncOrigin,
        phases: [
          async ({ em: phaseEm }) => {
            patient = await lockPatient(phaseEm, parsed.patientId, scope)
            assertPatientAcceptsNewEntries(patient)
            now = nextUpdatedAt(patient.updatedAt)
          },
          ({ em: phaseEm }) => {
            visit = phaseEm.create(PatientVisit, {
              id: visitId,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              patientId: parsed.patientId,
              teamMemberId: parsed.teamMemberId,
              teamMemberNameSnapshot: visitColumns.teamMemberNameSnapshot,
              resourceId: parsed.resourceId ?? null,
              resourceNameSnapshot: visitColumns.resourceNameSnapshot,
              startsAt,
              endsAt,
              timeZone: parsed.timeZone,
              description: visitColumns.description,
              status: 'planned',
              confirmedAt: null,
              confirmedByUserId: null,
              statusChangedAt: now,
              statusChangedByUserId: actorUserId,
              statusReason: null,
              isSettled: false,
              settledAt: null,
              settledByUserId: null,
              settlementReason: null,
              clientRequestId: parsed.clientRequestId,
              createRequestPayload: visitColumns.createRequestPayload,
              createdAt: now,
              updatedAt: now,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
              deletedAt: null,
            })
            phaseEm.persist(visit)
          },
          ({ em: phaseEm }) => {
            parsed.serviceProductIds.forEach((productId, position) => {
              const snapshot = serviceColumns.get(productId)
              if (!snapshot) throw new Error('[internal] Missing encrypted service snapshot')
              phaseEm.persist(phaseEm.create(PatientVisitService, {
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
                visitId,
                productId,
                ...snapshot,
                position,
                createdAt: now,
                updatedAt: now,
                createdByUserId: actorUserId,
                updatedByUserId: actorUserId,
                deletedAt: null,
              }))
            })
          },
          ({ em: phaseEm }) => {
            patient.updatedAt = now
            patient.updatedByUserId = actorUserId
            phaseEm.persist(patient)
          },
        ],
        sideEffect: () => ({
          entity: visit,
          identifiers: { id: visitId, tenantId: scope.tenantId, organizationId: scope.organizationId },
        }),
      })
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        const raced = await resolveIdempotentVisit(
          (ctx.container.resolve('em') as EntityManager).fork(),
          parsed.clientRequestId,
          digest,
          scope,
        )
        if (raced) return raced
      }
      throw error
    }
    return await loadVisitDecrypted(em, visitId, scope)
  },
  captureAfter: async (_input, result, ctx) => {
    const scope = requirePatientScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await serializeVisit(em, result, scope)
  },
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.visits.create', 'Schedule visit'),
      resourceKind: 'patient.patient_visit',
      resourceId: String(result.id),
      parentResourceKind: 'patient.patient',
      parentResourceId: String(result.patientId),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
      snapshotAfter: snapshots.after ?? null,
    }
  },
  async undo({ logEntry, ctx }) {
    const scope = requirePatientScope(ctx)
    const after = requireUndoSnapshot(logEntry.snapshotAfter, scope, 'after')
    await requireReferenceFeature(ctx, scope, 'patient.visits.manage')
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let deletedAt!: Date
    await em.begin()
    try {
      const patient = await lockPatient(em, after.patientId, scope)
      const visit = await lockVisit(em, after.id, scope)
      assertExpectedVersion(after.updatedAt, visit.updatedAt, VISIT_ENTITY_ID)
      assertVisitDeletable(visit)
      deletedAt = nextUpdatedAt(visit.updatedAt)
      visit.deletedAt = deletedAt
      visit.updatedAt = deletedAt
      visit.updatedByUserId = actorUserId
      em.persist(visit)
      await em.nativeUpdate(
        PatientVisitService,
        {
          visitId: after.id,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          deletedAt: null,
        } as FilterQuery<PatientVisitService>,
        { deletedAt, updatedAt: deletedAt, updatedByUserId: actorUserId },
      )
      patient.updatedAt = nextUpdatedAt(patient.updatedAt)
      patient.updatedByUserId = actorUserId
      em.persist(patient)
      await em.flush()
      await em.commit()
    } catch (error) {
      await em.rollback()
      throw error
    }
    await emitUndoVisitEvent('patient.visit.deleted', after, deletedAt)
  },
}

const updateVisitCommand: CommandHandler<Record<string, unknown>, PatientVisit> = {
  id: 'patient.visits.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const parsed = patientVisitUpdateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    const visit = await loadVisitDecrypted(em, parsed.id, scope)
    return { before: await serializeVisit(em, visit, scope) }
  },
  async execute(rawInput, ctx) {
    const parsed = patientVisitUpdateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    if (parsed.serviceProductIds !== undefined) {
      assertUniqueServiceProductIds(parsed.serviceProductIds)
    }
    const rootEm = ctx.container.resolve('em') as EntityManager
    const readEm = rootEm.fork()
    const current = await loadVisitDecrypted(readEm, parsed.id, scope)
    const currentServices = await readEm.find(PatientVisitService, {
      visitId: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientVisitService>, { orderBy: { position: 'asc' } })
    const em = rootEm.fork()

    const references = referenceService(ctx)
    let teamMember: ResolvedReference | null = null
    if (parsed.teamMemberId && parsed.teamMemberId !== current.teamMemberId) {
      await requireReferenceFeature(ctx, scope, 'staff.view')
      teamMember = await references.requireActiveTeamMember(parsed.teamMemberId, scope)
    }
    let resource: ResolvedReference | null | undefined
    if (parsed.resourceId !== undefined && parsed.resourceId !== (current.resourceId ?? null)) {
      if (parsed.resourceId) {
        await requireReferenceFeature(ctx, scope, 'resources.view')
        resource = await references.requireActiveResource(parsed.resourceId, scope)
      } else {
        resource = null
      }
    }

    const currentByProduct = new Map(currentServices.map((service) => [String(service.productId), service]))
    const addedProductIds = (parsed.serviceProductIds ?? []).filter((id) => !currentByProduct.has(id))
    let addedProducts: ResolvedProductReference[] = []
    if (parsed.serviceProductIds !== undefined && addedProductIds.length > 0) {
      await requireReferenceFeature(ctx, scope, 'catalog.products.view')
      addedProducts = await references.requireActiveProducts(addedProductIds, scope)
    }

    const encryption = tryResolveEncryptionService(ctx)
    const visitSensitive: Record<string, unknown> = {}
    if (teamMember) visitSensitive.teamMemberNameSnapshot = teamMember.displayName
    if (resource !== undefined) visitSensitive.resourceNameSnapshot = resource?.displayName ?? null
    if (parsed.description !== undefined) visitSensitive.description = parsed.description
    const visitColumns = await encryptSensitiveFields(VISIT_ENTITY_ID, visitSensitive, scope, encryption)
    const addedServiceColumns = await encryptServiceSnapshots(addedProducts, scope, encryption)

    let patient!: Patient
    let visit!: PatientVisit
    let updatedAt!: Date
    let resetConfirmation = false
    await runCrudCommandWrite<PatientVisit>({
      ctx,
      em,
      entityId: VISIT_ENTITY_ID,
      action: 'updated',
      scope,
      events: patientVisitCrudEvents,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: phaseEm }) => {
          patient = await lockPatient(phaseEm, String(current.patientId), scope)
          visit = await lockVisit(phaseEm, parsed.id, scope)
          assertExpectedVersion(parsed.expectedUpdatedAt, visit.updatedAt, VISIT_ENTITY_ID)
          assertVisitEditable(visit)
          const startsAt = parsed.startsAt !== undefined ? new Date(parsed.startsAt) : visit.startsAt
          const endsAt = parsed.endsAt !== undefined
            ? (parsed.endsAt ? new Date(parsed.endsAt) : null)
            : (visit.endsAt ?? null)
          const timeZone = parsed.timeZone ?? visit.timeZone
          assertSchedule(startsAt, endsAt)
          assertScheduleTimeZone(
            parsed.startsAt ?? storedInstantAtTimeZone(visit.startsAt, timeZone),
            parsed.endsAt !== undefined
              ? parsed.endsAt
              : visit.endsAt
                ? storedInstantAtTimeZone(visit.endsAt, timeZone)
                : null,
            timeZone,
          )
          updatedAt = nextUpdatedAt(visit.updatedAt)
        },
        ({ em: phaseEm }) => {
          const scheduleChanged =
            (parsed.teamMemberId !== undefined && parsed.teamMemberId !== visit.teamMemberId) ||
            (parsed.resourceId !== undefined && parsed.resourceId !== (visit.resourceId ?? null)) ||
            (parsed.startsAt !== undefined && new Date(parsed.startsAt).getTime() !== visit.startsAt.getTime()) ||
            (parsed.endsAt !== undefined && (parsed.endsAt ? new Date(parsed.endsAt).getTime() : null) !== (visit.endsAt?.getTime() ?? null)) ||
            (parsed.timeZone !== undefined && parsed.timeZone !== visit.timeZone)

          if (parsed.teamMemberId !== undefined) visit.teamMemberId = parsed.teamMemberId
          if (teamMember) visit.teamMemberNameSnapshot = String(visitColumns.teamMemberNameSnapshot)
          if (parsed.resourceId !== undefined) visit.resourceId = parsed.resourceId ?? null
          if (resource !== undefined) visit.resourceNameSnapshot = (visitColumns.resourceNameSnapshot as string | null) ?? null
          if (parsed.startsAt !== undefined) visit.startsAt = new Date(parsed.startsAt)
          if (parsed.endsAt !== undefined) visit.endsAt = parsed.endsAt ? new Date(parsed.endsAt) : null
          if (parsed.timeZone !== undefined) visit.timeZone = parsed.timeZone
          if (parsed.description !== undefined) visit.description = (visitColumns.description as string | null) ?? null
          if (scheduleChanged && visit.confirmedAt) {
            visit.confirmedAt = null
            visit.confirmedByUserId = null
            resetConfirmation = true
          }
          visit.updatedAt = updatedAt
          visit.updatedByUserId = actorUserId
          phaseEm.persist(visit)
        },
        async ({ em: phaseEm }) => {
          if (parsed.serviceProductIds === undefined) return
          const wanted = new Set(parsed.serviceProductIds)
          const removed = currentServices.filter((service) => !wanted.has(String(service.productId)))
          if (removed.length > 0) {
            await phaseEm.nativeUpdate(
              PatientVisitService,
              {
                id: { $in: removed.map((service) => String(service.id)) },
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
                visitId: parsed.id,
                deletedAt: null,
              } as FilterQuery<PatientVisitService>,
              { deletedAt: updatedAt, updatedAt, updatedByUserId: actorUserId },
            )
          }
          for (const [position, productId] of parsed.serviceProductIds.entries()) {
            const existing = currentByProduct.get(productId)
            if (existing) {
              await phaseEm.nativeUpdate(
                PatientVisitService,
                {
                  id: String(existing.id),
                  tenantId: scope.tenantId,
                  organizationId: scope.organizationId,
                  visitId: parsed.id,
                  deletedAt: null,
                } as FilterQuery<PatientVisitService>,
                { position, updatedAt, updatedByUserId: actorUserId },
              )
              continue
            }
            const snapshot = addedServiceColumns.get(productId)
            if (!snapshot) throw new Error('[internal] Missing encrypted service snapshot')
            phaseEm.persist(phaseEm.create(PatientVisitService, {
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              visitId: parsed.id,
              productId,
              ...snapshot,
              position,
              createdAt: updatedAt,
              updatedAt,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
              deletedAt: null,
            }))
          }
        },
        ({ em: phaseEm }) => {
          patient.updatedAt = nextUpdatedAt(patient.updatedAt)
          patient.updatedByUserId = actorUserId
          phaseEm.persist(patient)
        },
      ],
      sideEffect: () => ({
        entity: visit,
        identifiers: { id: parsed.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })

    if (resetConfirmation) {
      await emitPatientEvent('patient.visit.unconfirmed', {
        id: parsed.id,
        patientId: String(visit.patientId),
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        updatedAt: updatedAt.toISOString(),
      })
    }
    return await loadVisitDecrypted(em, parsed.id, scope)
  },
  captureAfter: async (_input, result, ctx) => {
    const scope = requirePatientScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await serializeVisit(em, result, scope)
  },
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.visits.update', 'Update visit'),
      resourceKind: 'patient.patient_visit',
      resourceId: String(result.id),
      parentResourceKind: 'patient.patient',
      parentResourceId: String(result.patientId),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
      snapshotBefore: snapshots.before ?? null,
      snapshotAfter: snapshots.after ?? null,
    }
  },
  async undo({ logEntry, ctx }) {
    const scope = requirePatientScope(ctx)
    const before = requireUndoSnapshot(logEntry.snapshotBefore, scope, 'before')
    const after = requireUndoSnapshot(logEntry.snapshotAfter, scope, 'after')
    await authorizeSnapshotReferences(ctx, scope, before)
    const actorUserId = requireActorUserId(ctx)
    const encryption = tryResolveEncryptionService(ctx)
    const encryptedVisit = await encryptVisitSnapshot(before, scope, encryption)
    const encryptedServices = await encryptServiceSnapshots(
      before.services.map((service) => ({
        id: service.productId,
        displayName: service.title,
        sku: service.sku,
        isAvailable: true,
      })),
      scope,
      encryption,
    )
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let updatedAt!: Date
    await em.begin()
    try {
      const patient = await lockPatient(em, before.patientId, scope)
      assertPatientAcceptsNewEntries(patient)
      const visit = await lockVisit(em, before.id, scope)
      assertExpectedVersion(after.updatedAt, visit.updatedAt, VISIT_ENTITY_ID)
      assertVisitEditable(visit)
      updatedAt = nextUpdatedAt(visit.updatedAt)
      restoreVisitHeader(visit, before, encryptedVisit, updatedAt, actorUserId)
      em.persist(visit)
      await restoreVisitServices(
        em,
        before,
        scope,
        actorUserId,
        updatedAt,
        encryptedServices,
      )
      patient.updatedAt = nextUpdatedAt(patient.updatedAt)
      patient.updatedByUserId = actorUserId
      em.persist(patient)
      await em.flush()
      await em.commit()
    } catch (error) {
      await em.rollback()
      throw error
    }
    await emitUndoVisitEvent('patient.visit.updated', before, updatedAt)
    if (before.confirmedAt && !after.confirmedAt) {
      await emitPatientEvent('patient.visit.confirmed', {
        id: before.id,
        patientId: before.patientId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        updatedAt: updatedAt.toISOString(),
      })
    }
  },
}

const deleteVisitCommand: CommandHandler<Record<string, unknown>, PatientVisit> = {
  id: 'patient.visits.delete',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const parsed = patientVisitDeleteSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const em = ctx.container.resolve('em') as EntityManager
    const visit = await loadVisitDecrypted(em, parsed.id, scope)
    return { before: await serializeVisit(em, visit, scope) }
  },
  async execute(rawInput, ctx) {
    const parsed = patientVisitDeleteSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const rootEm = ctx.container.resolve('em') as EntityManager
    const current = await loadVisitDecrypted(rootEm.fork(), parsed.id, scope)
    const em = rootEm.fork()
    let patient!: Patient
    let visit!: PatientVisit
    let deletedAt!: Date

    await runCrudCommandWrite<PatientVisit>({
      ctx,
      em,
      entityId: VISIT_ENTITY_ID,
      action: 'deleted',
      scope,
      events: patientVisitCrudEvents,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: phaseEm }) => {
          patient = await lockPatient(phaseEm, String(current.patientId), scope)
          visit = await lockVisit(phaseEm, parsed.id, scope)
          assertExpectedVersion(parsed.expectedUpdatedAt, visit.updatedAt, VISIT_ENTITY_ID)
          assertVisitDeletable(visit)
          deletedAt = nextUpdatedAt(visit.updatedAt)
        },
        ({ em: phaseEm }) => {
          visit.deletedAt = deletedAt
          visit.updatedAt = deletedAt
          visit.updatedByUserId = actorUserId
          phaseEm.persist(visit)
        },
        async ({ em: phaseEm }) => {
          await phaseEm.nativeUpdate(
            PatientVisitService,
            {
              visitId: parsed.id,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              deletedAt: null,
            } as FilterQuery<PatientVisitService>,
            { deletedAt, updatedAt: deletedAt, updatedByUserId: actorUserId },
          )
        },
        ({ em: phaseEm }) => {
          patient.updatedAt = nextUpdatedAt(patient.updatedAt)
          patient.updatedByUserId = actorUserId
          phaseEm.persist(patient)
        },
      ],
      sideEffect: () => ({
        entity: visit,
        identifiers: { id: parsed.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    })
    return visit
  },
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.visits.delete', 'Delete visit'),
      resourceKind: 'patient.patient_visit',
      resourceId: String(result.id),
      parentResourceKind: 'patient.patient',
      parentResourceId: String(result.patientId),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
      snapshotBefore: snapshots.before ?? null,
    }
  },
  async undo({ logEntry, ctx }) {
    const scope = requirePatientScope(ctx)
    const before = requireUndoSnapshot(logEntry.snapshotBefore, scope, 'before')
    await authorizeSnapshotReferences(ctx, scope, before)
    const actorUserId = requireActorUserId(ctx)
    const encryption = tryResolveEncryptionService(ctx)
    const encryptedVisit = await encryptVisitSnapshot(before, scope, encryption)
    const encryptedServices = await encryptServiceSnapshots(
      before.services.map((service) => ({
        id: service.productId,
        displayName: service.title,
        sku: service.sku,
        isAvailable: true,
      })),
      scope,
      encryption,
    )
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let updatedAt!: Date
    await em.begin()
    try {
      const patient = await lockPatient(em, before.patientId, scope)
      assertPatientAcceptsNewEntries(patient)
      const visit = await lockVisit(em, before.id, scope, { includeDeleted: true })
      if (!visit.deletedAt) {
        throw new CrudHttpError(409, {
          error: 'This visit is no longer deleted; undo was refused',
          code: 'undo_state_changed',
        })
      }
      if (visit.updatedAt.getTime() <= new Date(before.updatedAt).getTime()) {
        throw new CrudHttpError(409, {
          error: 'The deleted visit version is not the one recorded by this action',
          code: 'undo_version_mismatch',
        })
      }
      updatedAt = nextUpdatedAt(visit.updatedAt)
      restoreVisitHeader(visit, before, encryptedVisit, updatedAt, actorUserId)
      em.persist(visit)
      await restoreVisitServices(
        em,
        before,
        scope,
        actorUserId,
        updatedAt,
        encryptedServices,
      )
      patient.updatedAt = nextUpdatedAt(patient.updatedAt)
      patient.updatedByUserId = actorUserId
      em.persist(patient)
      await em.flush()
      await em.commit()
    } catch (error) {
      await em.rollback()
      throw error
    }
    await emitUndoVisitEvent('patient.visit.created', before, updatedAt)
  },
}

type VisitLifecycleOperation = 'confirm' | 'unconfirm' | 'transition' | 'settle' | 'unsettle'

type VisitLifecycleInput = {
  id: string
  expectedUpdatedAt: string
  status?: PatientVisitStatus
  reason?: string
}

type VisitLifecycleAuditSnapshot = {
  id: string
  patientId: string
  status: PatientVisitStatus
  statusChangedAt: string
  statusChangedByUserId: string
  confirmedAt: string | null
  confirmedByUserId: string | null
  isSettled: boolean
  settledAt: string | null
  settledByUserId: string | null
  updatedAt: string
  tenantId: string
  organizationId: string
}

type VisitLifecycleCommandDefinition = {
  id: string
  operation: VisitLifecycleOperation
  labelKey: string
  label: string
  parse(input: Record<string, unknown>): VisitLifecycleInput
}

function codedConflict(message: string, code: string): CrudHttpError {
  const error = conflict(message)
  error.body.code = code
  return error
}

function codedForbidden(message: string, code: string): CrudHttpError {
  const error = forbidden(message)
  error.body.code = code
  return error
}

function lifecycleSnapshot(visit: PatientVisit, scope: PatientScope): VisitLifecycleAuditSnapshot {
  return {
    id: String(visit.id),
    patientId: String(visit.patientId),
    status: visit.status,
    statusChangedAt: visit.statusChangedAt.toISOString(),
    statusChangedByUserId: String(visit.statusChangedByUserId),
    confirmedAt: visit.confirmedAt?.toISOString() ?? null,
    confirmedByUserId: visit.confirmedByUserId ?? null,
    isSettled: Boolean(visit.isSettled),
    settledAt: visit.settledAt?.toISOString() ?? null,
    settledByUserId: visit.settledByUserId ?? null,
    updatedAt: visit.updatedAt.toISOString(),
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  }
}

function lifecycleFeatures(
  operation: VisitLifecycleOperation,
  input: VisitLifecycleInput,
): string[] {
  if (operation === 'settle' || operation === 'unsettle') return ['patient.visits.settle']
  if (operation === 'transition' && input.status === 'planned') {
    return ['patient.visits.manage', 'patient.visits.correct']
  }
  return ['patient.visits.manage']
}

async function requireVisitFeatures(
  ctx: CommandRuntimeContext,
  scope: PatientScope,
  required: string[],
): Promise<void> {
  const userId = requireActorUserId(ctx)
  let rbac: ScopedRbacService
  try {
    rbac = ctx.container.resolve('rbacService') as ScopedRbacService
  } catch {
    throw new CrudHttpError(503, {
      error: 'The authorization service required for visit actions is unavailable',
      code: 'visit_authorization_unavailable',
    })
  }
  if (!(await rbac.userHasAllFeatures(userId, required, scope))) {
    throw codedForbidden('You do not have permission to perform this visit action', 'visit_action_forbidden')
  }
}

/**
 * Pure transition oracle shared by the command and its table-driven tests.
 * Time never changes a visit automatically; it only gates explicit completion/no-show.
 */
export function assertPatientVisitTransition(
  current: PatientVisitStatus,
  target: PatientVisitStatus,
  startsAt: Date,
  now: Date,
): void {
  if (target === 'planned') {
    if (current === 'planned') {
      throw codedConflict('This visit is already planned', 'visit_status_unchanged')
    }
    return
  }
  if (current !== 'planned') {
    throw codedConflict('Only a planned visit can be closed', 'visit_transition_not_allowed')
  }
  if ((target === 'completed' || target === 'no_show') && startsAt.getTime() > now.getTime()) {
    throw new CrudHttpError(422, {
      error: target === 'completed'
        ? 'A visit cannot be completed before its start time'
        : 'A patient cannot be marked absent before the visit start time',
      code: target === 'completed' ? 'visit_completion_before_start' : 'visit_no_show_before_start',
    })
  }
}

function lifecycleChanges(
  definition: VisitLifecycleCommandDefinition,
  input: VisitLifecycleInput,
  before: VisitLifecycleAuditSnapshot | undefined,
): Record<string, unknown> {
  if (definition.operation === 'confirm' || definition.operation === 'unconfirm') {
    return { confirmed: { from: Boolean(before?.confirmedAt), to: definition.operation === 'confirm' } }
  }
  if (definition.operation === 'settle' || definition.operation === 'unsettle') {
    return {
      isSettled: { from: Boolean(before?.isSettled), to: definition.operation === 'settle' },
      reasonProvided: Boolean(input.reason),
    }
  }
  return {
    status: { from: before?.status ?? null, to: input.status ?? null },
    reasonProvided: Boolean(input.reason),
  }
}

async function executeVisitLifecycleAction(
  input: VisitLifecycleInput,
  ctx: CommandRuntimeContext,
  operation: VisitLifecycleOperation,
): Promise<PatientVisit> {
  const scope = requirePatientScope(ctx)
  const actorUserId = requireActorUserId(ctx)
  await requireVisitFeatures(ctx, scope, lifecycleFeatures(operation, input))

  const rootEm = ctx.container.resolve('em') as EntityManager
  const current = await loadVisitDecrypted(rootEm.fork(), input.id, scope)
  const em = rootEm.fork()
  const encryption = tryResolveEncryptionService(ctx)
  const encryptedReason: Record<string, unknown> = input.reason
    ? await encryptSensitiveFields(
      VISIT_ENTITY_ID,
      operation === 'settle' || operation === 'unsettle'
        ? { settlementReason: input.reason }
        : { statusReason: input.reason },
      scope,
      encryption,
    )
    : {}

  let patient!: Patient
  let visit!: PatientVisit
  let updatedAt!: Date
  let confirmationCleared = false
  const wallClockNow = new Date()

  await runCrudCommandWrite<PatientVisit>({
    ctx,
    em,
    entityId: VISIT_ENTITY_ID,
    action: 'updated',
    scope,
    syncOrigin: ctx.syncOrigin,
    phases: [
      async ({ em: phaseEm }) => {
        patient = await lockPatient(phaseEm, String(current.patientId), scope)
        visit = await lockVisit(phaseEm, input.id, scope)
        assertExpectedVersion(input.expectedUpdatedAt, visit.updatedAt, VISIT_ENTITY_ID)
        updatedAt = nextUpdatedAt(patient.updatedAt > visit.updatedAt ? patient.updatedAt : visit.updatedAt)
      },
      ({ em: phaseEm }) => {
        if (operation === 'confirm' || operation === 'unconfirm') {
          if (visit.status !== 'planned') {
            throw codedConflict(
              'Confirmation can only be changed for a planned visit',
              'visit_confirmation_not_applicable',
            )
          }
          const shouldConfirm = operation === 'confirm'
          if (Boolean(visit.confirmedAt) === shouldConfirm) {
            throw codedConflict('The visit confirmation already has this value', 'visit_confirmation_unchanged')
          }
          visit.confirmedAt = shouldConfirm ? updatedAt : null
          visit.confirmedByUserId = shouldConfirm ? actorUserId : null
        } else if (operation === 'transition') {
          const target = input.status
          if (!target) throw new Error('[internal] Missing parsed visit target status')
          assertPatientVisitTransition(visit.status, target, visit.startsAt, wallClockNow)
          confirmationCleared = target === 'planned' && Boolean(visit.confirmedAt)
          visit.status = target
          visit.statusReason = input.reason
            ? String(encryptedReason.statusReason)
            : null
          visit.statusChangedAt = updatedAt
          visit.statusChangedByUserId = actorUserId
          if (target === 'planned') {
            visit.confirmedAt = null
            visit.confirmedByUserId = null
          }
        } else {
          const shouldSettle = operation === 'settle'
          if (visit.isSettled === shouldSettle) {
            throw codedConflict('The visit settlement already has this value', 'visit_settlement_unchanged')
          }
          visit.isSettled = shouldSettle
          visit.settledAt = shouldSettle ? updatedAt : null
          visit.settledByUserId = shouldSettle ? actorUserId : null
          visit.settlementReason = input.reason
            ? String(encryptedReason.settlementReason)
            : null
        }
        visit.updatedAt = updatedAt
        visit.updatedByUserId = actorUserId
        phaseEm.persist(visit)
      },
      ({ em: phaseEm }) => {
        patient.updatedAt = updatedAt
        patient.updatedByUserId = actorUserId
        phaseEm.persist(patient)
      },
    ],
    sideEffect: () => ({
      entity: visit,
      identifiers: { id: input.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    }),
  })

  const eventPayload = {
    id: input.id,
    patientId: String(visit.patientId),
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    updatedAt: updatedAt.toISOString(),
  }
  if (operation === 'confirm') {
    await emitPatientEvent('patient.visit.confirmed', eventPayload)
  } else if (operation === 'unconfirm') {
    await emitPatientEvent('patient.visit.unconfirmed', eventPayload)
  } else if (operation === 'transition') {
    await emitPatientEvent('patient.visit.status_changed', { ...eventPayload, status: visit.status })
    if (confirmationCleared) await emitPatientEvent('patient.visit.unconfirmed', eventPayload)
  } else {
    await emitPatientEvent('patient.visit.settlement_changed', { ...eventPayload, isSettled: visit.isSettled })
  }
  return await loadVisitDecrypted(em, input.id, scope)
}

function createVisitLifecycleCommand(
  definition: VisitLifecycleCommandDefinition,
): CommandHandler<Record<string, unknown>, PatientVisit> {
  return {
    id: definition.id,
    // Reversal is an explicit, reasoned domain action (unconfirm/reopen/unsettle),
    // never a generic undo that could bypass its dedicated feature or transition rule.
    isUndoable: false,
    async prepare(rawInput, ctx) {
      const input = definition.parse(rawInput)
      const scope = requirePatientScope(ctx)
      requireActorUserId(ctx)
      await requireVisitFeatures(ctx, scope, lifecycleFeatures(definition.operation, input))
      const em = (ctx.container.resolve('em') as EntityManager).fork()
      const visit = await loadVisitDecrypted(em, input.id, scope)
      return { before: lifecycleSnapshot(visit, scope) }
    },
    async execute(rawInput, ctx) {
      const input = definition.parse(rawInput)
      return await executeVisitLifecycleAction(input, ctx, definition.operation)
    },
    async captureAfter(_rawInput, result, ctx) {
      return lifecycleSnapshot(result, requirePatientScope(ctx))
    },
    async buildLog({ input: rawInput, result, snapshots }) {
      const input = definition.parse(rawInput)
      const { translate } = await resolveTranslations()
      return {
        actionLabel: translate(definition.labelKey, definition.label),
        resourceKind: 'patient.patient_visit',
        resourceId: String(result.id),
        parentResourceKind: 'patient.patient',
        parentResourceId: String(result.patientId),
        tenantId: String(result.tenantId),
        organizationId: String(result.organizationId),
        snapshotBefore: snapshots.before ?? null,
        snapshotAfter: snapshots.after ?? null,
        // Free-text reasons remain only in encrypted entity fields; audit records presence only.
        changes: lifecycleChanges(
          definition,
          input,
          snapshots.before as VisitLifecycleAuditSnapshot | undefined,
        ),
      }
    },
  }
}

const confirmVisitCommand = createVisitLifecycleCommand({
  id: 'patient.visits.confirm',
  operation: 'confirm',
  labelKey: 'patient.audit.visits.confirm',
  label: 'Confirm visit',
  parse: (input) => patientVisitConfirmationActionSchema.parse(input),
})

const unconfirmVisitCommand = createVisitLifecycleCommand({
  id: 'patient.visits.unconfirm',
  operation: 'unconfirm',
  labelKey: 'patient.audit.visits.unconfirm',
  label: 'Unconfirm visit',
  parse: (input) => patientVisitConfirmationActionSchema.parse(input),
})

const transitionVisitCommand = createVisitLifecycleCommand({
  id: 'patient.visits.transition',
  operation: 'transition',
  labelKey: 'patient.audit.visits.transition',
  label: 'Change visit status',
  parse: (input) => patientVisitTransitionSchema.parse(input),
})

const settleVisitCommand = createVisitLifecycleCommand({
  id: 'patient.visits.settle',
  operation: 'settle',
  labelKey: 'patient.audit.visits.settle',
  label: 'Mark visit as manually settled',
  parse: (input) => patientVisitSettleSchema.parse(input),
})

const unsettleVisitCommand = createVisitLifecycleCommand({
  id: 'patient.visits.unsettle',
  operation: 'unsettle',
  labelKey: 'patient.audit.visits.unsettle',
  label: 'Remove manual visit settlement',
  parse: (input) => patientVisitUnsettleSchema.parse(input),
})

registerCommand(createVisitCommand)
registerCommand(updateVisitCommand)
registerCommand(deleteVisitCommand)
registerCommand(confirmVisitCommand)
registerCommand(unconfirmVisitCommand)
registerCommand(transitionVisitCommand)
registerCommand(settleVisitCommand)
registerCommand(unsettleVisitCommand)
