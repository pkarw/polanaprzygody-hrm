import { randomUUID } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { conflict, CrudHttpError, forbidden, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEmitContext, CrudEventsConfig } from '@open-mercato/shared/lib/crud/types'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { Patient, PatientVisit, PatientVisitService, type PatientVisitStatus } from '../data/entities'
import {
  PATIENT_VISIT_MAX_SPAN_MS,
  patientVisitCreateSchema,
  patientVisitConfirmActionSchema,
  patientVisitDeleteSchema,
  patientVisitEnsurePaymentLinkActionSchema,
  patientVisitInstantMatchesTimeZone,
  patientVisitSettleSchema,
  patientVisitSendPaymentLinkEmailActionSchema,
  patientVisitTransitionSchema,
  patientVisitUnsettleSchema,
  patientVisitUnconfirmActionSchema,
  patientVisitUpdateSchema,
} from '../data/validators'
import { emitPatientEvent } from '../events'
import type {
  PatientReferenceService,
  ResolvedProductReference,
  ResolvedReference,
} from '../lib/patientReferenceService'
import type {
  PatientAvailabilityService,
  PlannerAvailabilityService,
} from '../lib/patientAvailabilityService'
import { evaluateVisitConflicts, type VisitConflict, type VisitConflictDraft } from '../lib/visitConflicts'
import {
  VisitPaymentLinkError,
  type VisitPaymentLink,
  type VisitPaymentLinkService,
} from '../lib/visitPaymentLinkService'
import { PATIENT_VISIT_ENTITY_ID } from '../lib/visitPaymentFields'
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
  conflictOverrideReason: string | null
  conflictOverrideAt: string | null
  conflictOverrideByUserId: string | null
  conflictOverrideCodes: string[] | null
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

async function referenceService(ctx: CommandRuntimeContext): Promise<PatientReferenceService> {
  try {
    return ctx.container.resolve('patientReferenceService') as PatientReferenceService
  } catch {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(503, {
      error: translate(
        'patient.errors.visitReferenceServiceUnavailable',
        'The reference service required for patient visits is unavailable',
      ),
      code: 'visit_reference_service_unavailable',
    })
  }
}

async function availabilityService(ctx: CommandRuntimeContext): Promise<PatientAvailabilityService> {
  try {
    return ctx.container.resolve('patientAvailabilityService') as PatientAvailabilityService
  } catch {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(503, {
      error: translate(
        'patient.errors.visitAvailabilityServiceUnavailable',
        'The availability service required for patient visits is unavailable',
      ),
      code: 'visit_availability_service_unavailable',
    })
  }
}

function optionalPlannerAvailabilityService(ctx: CommandRuntimeContext): PlannerAvailabilityService | null {
  try {
    return ctx.container.resolve('plannerAvailabilityService') as PlannerAvailabilityService
  } catch {
    return null
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
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(503, {
      error: translate(
        'patient.errors.visitReferenceAuthorizationUnavailable',
        'The authorization service required for visit references is unavailable',
      ),
      code: 'visit_reference_authorization_unavailable',
    })
  }
  if (!(await rbac.userHasAllFeatures(userId, [feature], scope))) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(403, {
      error: translate('patient.errors.visitReferenceForbidden', 'You do not have access to the referenced records'),
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
  if (!visit) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(404, { error: translate('patient.errors.visitNotFound', 'Visit not found') })
  }
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
      const { translate } = await resolveTranslations()
      throw new CrudHttpError(409, {
        error: translate('patient.errors.visitLocked', 'This visit is being changed right now; try again in a moment'),
        code: 'visit_locked',
      })
    }
    throw error
  }
  if (!visit) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(404, { error: translate('patient.errors.visitNotFound', 'Visit not found') })
  }
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
    conflictOverrideReason: visit.conflictOverrideReason ?? null,
    conflictOverrideAt: visit.conflictOverrideAt?.toISOString() ?? null,
    conflictOverrideByUserId: visit.conflictOverrideByUserId ?? null,
    conflictOverrideCodes: visit.conflictOverrideCodes ? [...visit.conflictOverrideCodes] : null,
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

async function assertSchedule(startsAt: Date, endsAt: Date | null): Promise<void> {
  if (!endsAt) return
  if (endsAt.getTime() <= startsAt.getTime()) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(422, {
      error: translate('patient.errors.visitEndNotAfterStart', 'The visit end must be later than its start'),
      code: 'visit_end_not_after_start',
    })
  }
  // Availability evaluation expands every planner rule across this span, so an unbounded
  // span blocks the event loop instead of merely storing an odd row.
  if (endsAt.getTime() - startsAt.getTime() > PATIENT_VISIT_MAX_SPAN_MS) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(422, {
      error: translate('patient.errors.visitSpanTooLong', 'The visit cannot span more than 31 days'),
      code: 'visit_span_too_long',
    })
  }
}

async function assertUniqueServiceProductIds(productIds: string[]): Promise<void> {
  if (new Set(productIds).size !== productIds.length) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(409, {
      error: translate('patient.errors.visitServiceDuplicate', 'The same service cannot be selected twice'),
      code: 'visit_service_duplicate',
    })
  }
}

async function assertScheduleTimeZone(
  startsAt: string | undefined,
  endsAt: string | null | undefined,
  timeZone: string,
): Promise<void> {
  if (
    (startsAt !== undefined && !patientVisitInstantMatchesTimeZone(startsAt, timeZone)) ||
    (endsAt !== undefined && endsAt !== null && !patientVisitInstantMatchesTimeZone(endsAt, timeZone))
  ) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(422, {
      error: translate(
        'patient.errors.visitTimeZoneMismatch',
        'The visit time and explicit offset must exist in the selected time zone',
      ),
      code: 'visit_time_zone_mismatch',
    })
  }
}

async function storedInstantAtTimeZone(instant: Date, timeZone: string): Promise<string> {
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
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(422, {
      error: translate(
        'patient.errors.visitStoredTimeZoneMismatch',
        'The stored visit instant cannot be represented in the selected time zone',
      ),
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

async function assertVisitEditable(visit: PatientVisit): Promise<void> {
  if (visit.status !== 'planned') {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(409, {
      error: translate('patient.errors.visitNotEditable', 'A closed visit must be reopened before it can be edited'),
      code: 'visit_not_editable',
    })
  }
}

async function assertVisitDeletable(visit: PatientVisit): Promise<void> {
  if (visit.status !== 'planned' || visit.isSettled) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(409, {
      error: translate('patient.errors.visitNotDeletable', 'Only a planned, unsettled visit can be deleted'),
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
  const references = await referenceService(ctx)
  const teamMember = await references.requireActiveTeamMember(input.teamMemberId, scope)

  let resource: ResolvedReference | null = null
  if (input.resourceId) {
    resource = (await references.resolveResources([input.resourceId], scope)).get(input.resourceId) ?? null
    if (!resource) {
      const { translate } = await resolveTranslations()
      throw new CrudHttpError(422, {
        error: translate('patient.errors.visitReferenceUnavailable', 'A selected visit reference is unavailable'),
        code: 'visit_reference_unavailable',
      })
    }
  }

  let products: ResolvedProductReference[] = []
  if (input.serviceProductIds.length > 0) {
    products = await references.requireActiveProducts(input.serviceProductIds, scope)
  }
  return { teamMember, resource, products }
}

export async function acquireVisitSubjectLocks(
  em: EntityManager,
  scope: PatientScope,
  subjects: Array<{ type: 'member' | 'resource'; id: string | null | undefined }>,
): Promise<void> {
  const keys = Array.from(new Set(subjects
    .filter((subject): subject is { type: 'member' | 'resource'; id: string } => Boolean(subject.id))
    .map((subject) => `patient:visit-slot:${scope.tenantId}:${scope.organizationId}:${subject.type}:${subject.id}`)))
    .sort()
  try {
    for (const key of keys) {
      // `em.execute` and NOT `em.getConnection().execute`: the latter leaves `ctx` undefined,
      // so `AbstractSqlConnection.execute` falls back to `(ctx ?? this.#client)` — the pool.
      // A `pg_advisory_xact_lock` taken on a pooled connection lives in its own implicit
      // single-statement transaction and is released before the call returns, which is no
      // mutual exclusion at all. `SqlEntityManager.execute` forwards
      // `getTransactionContext()`, so the lock is held until the enclosing transaction ends
      // and the transaction-local `lock_timeout` from `applyLockWaitBound` applies to it.
      await em.execute(
        'select pg_advisory_xact_lock(hashtextextended(?::text, 0))',
        [key],
      )
    }
  } catch (error) {
    if (isLockWaitTimeout(error)) {
      const { translate } = await resolveTranslations()
      throw new CrudHttpError(409, {
        error: translate(
          'patient.errors.visitScheduleLocked',
          'This visit schedule is being changed right now; try again in a moment',
        ),
        code: 'visit_schedule_locked',
      })
    }
    throw error
  }
}

async function evaluateCommandConflicts(input: {
  ctx: CommandRuntimeContext
  em: EntityManager
  scope: PatientScope
  draft: VisitConflictDraft
  excludeVisitId?: string
  /**
   * The activity flag the caller already resolved for `draft.resourceId`. Passed so a degraded
   * resource read inside the availability service cannot downgrade a known-inactive room from
   * the blocking `resource_inactive` to a non-blocking `availability_unknown`.
   */
  resourceIsActive?: boolean
}): Promise<VisitConflict[]> {
  const service = await availabilityService(input.ctx)
  const [subjects, overlappingVisits] = await Promise.all([
    service.getSubjectAvailability({
      scope: input.scope,
      range: {
        start: input.draft.startsAt,
        end: input.draft.endsAt ?? new Date(input.draft.startsAt.getTime() + 60_000),
      },
      teamMember: { id: input.draft.teamMemberId, name: input.draft.teamMemberName },
      ...(input.draft.resourceId ? {
        resource: {
          id: input.draft.resourceId,
          name: input.draft.resourceName ?? '',
          isActive: input.resourceIsActive,
        },
      } : {}),
      plannerAvailabilityService: optionalPlannerAvailabilityService(input.ctx),
    }),
    service.findOverlappingVisits({
      scope: input.scope,
      draft: input.draft,
      excludeVisitId: input.excludeVisitId,
      em: input.em,
    }),
  ])
  return evaluateVisitConflicts({ draft: input.draft, subjects, overlappingVisits })
}

export async function assertConflictDecision(
  ctx: CommandRuntimeContext,
  scope: PatientScope,
  conflicts: VisitConflict[],
  override: { acknowledgedSignatures: string[]; reason: string } | undefined,
): Promise<{ codes: string[]; reason: string } | null> {
  const blocking = conflicts.filter((item) => item.severity === 'blocking')
  if (blocking.length > 0) {
    throw new CrudHttpError(422, { error: 'visit_conflict_blocking', conflicts })
  }
  const warnings = conflicts.filter((item) => item.severity === 'warning')
  const expected = Array.from(new Set(warnings.map((item) => item.signature))).sort()
  const acknowledged = Array.from(new Set(override?.acknowledgedSignatures ?? [])).sort()
  if (expected.length === 0) {
    if (acknowledged.length > 0) {
      throw new CrudHttpError(422, { error: 'visit_conflict_unacknowledged', conflicts })
    }
    return null
  }
  if (!override || expected.length !== acknowledged.length || expected.some((value, index) => value !== acknowledged[index])) {
    throw new CrudHttpError(422, { error: 'visit_conflict_unacknowledged', conflicts })
  }
  await requireReferenceFeature(ctx, scope, 'patient.visits.override_conflict')
  return {
    codes: Array.from(new Set(warnings.map((item) => item.code)).values()).sort(),
    reason: override.reason,
  }
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

async function requireUndoSnapshot(
  value: unknown,
  scope: PatientScope,
  kind: 'before' | 'after',
): Promise<VisitAuditSnapshot> {
  const snapshot = value as VisitAuditSnapshot | null | undefined
  if (!snapshot?.id || !snapshot.patientId) {
    throw new Error(`[internal] Missing visit ${kind} snapshot for undo`)
  }
  if (snapshot.tenantId !== scope.tenantId || snapshot.organizationId !== scope.organizationId) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(403, {
      error: translate('patient.errors.visitUndoScopeMismatch', 'Undo scope does not match the visit scope'),
    })
  }
  return snapshot
}

export async function authorizeSnapshotReferences(
  ctx: CommandRuntimeContext,
  scope: PatientScope,
  snapshot: VisitAuditSnapshot,
): Promise<void> {
  // Undo re-authorizes the operator, not the historical choices. The encrypted snapshot was
  // already validated when it was written; requiring those host rows to remain active would
  // make an update/delete permanently non-undoable as soon as a clinician, room, or service
  // is retired. Scalar ids and snapshots intentionally preserve that history.
  await requireReferenceFeature(ctx, scope, 'patient.visits.manage')
  await requireReferenceFeature(ctx, scope, 'staff.view')
  if (snapshot.resourceId) {
    await requireReferenceFeature(ctx, scope, 'resources.view')
  }
  if (snapshot.services.length > 0) {
    await requireReferenceFeature(ctx, scope, 'catalog.products.view')
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
      conflictOverrideReason: snapshot.conflictOverrideReason,
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
  visit.conflictOverrideReason = (encrypted.conflictOverrideReason as string | null) ?? null
  visit.conflictOverrideAt = snapshot.conflictOverrideAt ? new Date(snapshot.conflictOverrideAt) : null
  visit.conflictOverrideByUserId = snapshot.conflictOverrideByUserId
  visit.conflictOverrideCodes = snapshot.conflictOverrideCodes ? [...snapshot.conflictOverrideCodes] : null
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
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(409, {
      error: translate(
        'patient.errors.idempotencyPayloadMismatch',
        'This request id was already used with different content',
      ),
      code: 'idempotency_payload_mismatch',
    })
  }
  if (existing.deletedAt) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(409, {
      error: translate(
        'patient.errors.visitIdempotencyRecordDeleted',
        'This request id belongs to a visit that was deleted',
      ),
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
    // Every command reaches its own guard: `makeCrudRoute` only covers the HTTP caller,
    // and a command bus caller (AI tool, CLI, import job, subscriber) bypasses that.
    await requireReferenceFeature(ctx, scope, 'patient.visits.manage')
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    await assertUniqueServiceProductIds(parsed.serviceProductIds)
    const startsAt = new Date(parsed.startsAt)
    const endsAt = parsed.endsAt ? new Date(parsed.endsAt) : null
    await assertSchedule(startsAt, endsAt)
    await assertScheduleTimeZone(parsed.startsAt, parsed.endsAt, parsed.timeZone)

    const digest = createRequestDigest({
      patientId: parsed.patientId,
      teamMemberId: parsed.teamMemberId,
      resourceId: parsed.resourceId ?? null,
      startsAt: new Date(parsed.startsAt).toISOString(),
      endsAt: parsed.endsAt ? new Date(parsed.endsAt).toISOString() : null,
      timeZone: parsed.timeZone,
      description: parsed.description ?? null,
      serviceProductIds: parsed.serviceProductIds,
      conflictOverride: parsed.conflictOverride
        ? {
            acknowledgedSignatures: [...parsed.conflictOverride.acknowledgedSignatures].sort(),
            reason: parsed.conflictOverride.reason,
          }
        : null,
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
        conflictOverrideReason: parsed.conflictOverride?.reason ?? null,
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
    const conflictDecision = { current: null as { codes: string[]; reason: string } | null }
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
            await acquireVisitSubjectLocks(phaseEm, scope, [
              { type: 'member', id: parsed.teamMemberId },
              { type: 'resource', id: parsed.resourceId },
            ])
            const conflicts = await evaluateCommandConflicts({
              ctx,
              em: phaseEm,
              scope,
              draft: {
                teamMemberId: parsed.teamMemberId,
                teamMemberName: resolved.teamMember.displayName,
                resourceId: parsed.resourceId ?? null,
                resourceName: resolved.resource?.displayName ?? null,
                startsAt,
                endsAt,
              },
              resourceIsActive: resolved.resource?.isAvailable,
            })
            conflictDecision.current = await assertConflictDecision(ctx, scope, conflicts, parsed.conflictOverride)
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
              conflictOverrideReason: conflictDecision.current ? visitColumns.conflictOverrideReason : null,
              conflictOverrideAt: conflictDecision.current ? now : null,
              conflictOverrideByUserId: conflictDecision.current ? actorUserId : null,
              conflictOverrideCodes: conflictDecision.current?.codes ?? null,
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
      // Availability enforcement can observe the winner before this retry reaches the
      // unique index: both requests miss the optimistic replay read, the first commits,
      // and the second then sees that same visit as an overlap after the patient lock.
      // In either race shape, an identical committed request is the authoritative result.
      // Keep unrelated validation, infrastructure and side-effect failures visible;
      // only the two errors emitted by availability conflict evaluation are eligible.
      const mayBeConcurrentReplay = error instanceof UniqueConstraintViolationException || (
        isCrudHttpError(error) &&
        error.status === 422 &&
        (error.body.error === 'visit_conflict_blocking' || error.body.error === 'visit_conflict_unacknowledged')
      )
      if (mayBeConcurrentReplay) {
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
    if (conflictDecision.current) {
      await emitPatientEvent('patient.visit.conflict_overridden', {
        id: visitId,
        patientId: parsed.patientId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        codes: conflictDecision.current.codes,
        updatedAt: now.toISOString(),
      })
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
    const after = await requireUndoSnapshot(logEntry.snapshotAfter, scope, 'after')
    await requireReferenceFeature(ctx, scope, 'patient.visits.manage')
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let deletedAt!: Date
    await em.begin()
    try {
      const patient = await lockPatient(em, after.patientId, scope)
      const visit = await lockVisit(em, after.id, scope)
      assertExpectedVersion(after.updatedAt, visit.updatedAt, VISIT_ENTITY_ID)
      await assertVisitDeletable(visit)
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
    // Every command reaches its own guard: `makeCrudRoute` only covers the HTTP caller,
    // and a command bus caller (AI tool, CLI, import job, subscriber) bypasses that.
    await requireReferenceFeature(ctx, scope, 'patient.visits.manage')
    const actorUserId = requireActorUserId(ctx)
    if (parsed.serviceProductIds !== undefined) {
      await assertUniqueServiceProductIds(parsed.serviceProductIds)
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

    const references = await referenceService(ctx)
    let teamMember: ResolvedReference | null = null
    if (parsed.teamMemberId && parsed.teamMemberId !== current.teamMemberId) {
      await requireReferenceFeature(ctx, scope, 'staff.view')
      teamMember = await references.requireActiveTeamMember(parsed.teamMemberId, scope)
    }
    let resource: ResolvedReference | null | undefined
    if (parsed.resourceId !== undefined && parsed.resourceId !== (current.resourceId ?? null)) {
      if (parsed.resourceId) {
        await requireReferenceFeature(ctx, scope, 'resources.view')
        resource = (await references.resolveResources([parsed.resourceId], scope)).get(parsed.resourceId) ?? undefined
        if (!resource) {
          const { translate } = await resolveTranslations()
          throw new CrudHttpError(422, {
            error: translate('patient.errors.visitReferenceUnavailable', 'A selected visit reference is unavailable'),
            code: 'visit_reference_unavailable',
          })
        }
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
    if (parsed.conflictOverride) visitSensitive.conflictOverrideReason = parsed.conflictOverride.reason
    const visitColumns = await encryptSensitiveFields(VISIT_ENTITY_ID, visitSensitive, scope, encryption)
    const addedServiceColumns = await encryptServiceSnapshots(addedProducts, scope, encryption)

    let patient!: Patient
    let visit!: PatientVisit
    let updatedAt!: Date
    let resetConfirmation = false
    const conflictDecision = { current: null as { codes: string[]; reason: string } | null }
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
          await assertVisitEditable(visit)
          const startsAt = parsed.startsAt !== undefined ? new Date(parsed.startsAt) : visit.startsAt
          const endsAt = parsed.endsAt !== undefined
            ? (parsed.endsAt ? new Date(parsed.endsAt) : null)
            : (visit.endsAt ?? null)
          const timeZone = parsed.timeZone ?? visit.timeZone
          await assertSchedule(startsAt, endsAt)
          await assertScheduleTimeZone(
            parsed.startsAt ?? (await storedInstantAtTimeZone(visit.startsAt, timeZone)),
            parsed.endsAt !== undefined
              ? parsed.endsAt
              : visit.endsAt
                ? await storedInstantAtTimeZone(visit.endsAt, timeZone)
                : null,
            timeZone,
          )
          const teamMemberId = parsed.teamMemberId ?? String(visit.teamMemberId)
          const resourceId = parsed.resourceId !== undefined ? parsed.resourceId : (visit.resourceId ?? null)
          await acquireVisitSubjectLocks(phaseEm, scope, [
            { type: 'member', id: String(visit.teamMemberId) },
            { type: 'resource', id: visit.resourceId },
            { type: 'member', id: teamMemberId },
            { type: 'resource', id: resourceId },
          ])
          const conflicts = await evaluateCommandConflicts({
            ctx,
            em: phaseEm,
            scope,
            excludeVisitId: parsed.id,
            draft: {
              teamMemberId,
              teamMemberName: teamMember?.displayName ?? String(visit.teamMemberNameSnapshot),
              resourceId: resourceId ?? null,
              resourceName: resource === undefined
                ? (visit.resourceNameSnapshot ?? null)
                : (resource?.displayName ?? null),
              startsAt,
              endsAt,
            },
            // `undefined` when the payload left the resource untouched: nothing was re-resolved
            // on this write, so the service's own read stays authoritative.
            resourceIsActive: resource === undefined ? undefined : resource?.isAvailable,
          })
          conflictDecision.current = await assertConflictDecision(ctx, scope, conflicts, parsed.conflictOverride)
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
          visit.conflictOverrideReason = conflictDecision.current
            ? String(visitColumns.conflictOverrideReason)
            : null
          visit.conflictOverrideAt = conflictDecision.current ? updatedAt : null
          visit.conflictOverrideByUserId = conflictDecision.current ? actorUserId : null
          visit.conflictOverrideCodes = conflictDecision.current?.codes ?? null
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
    if (conflictDecision.current) {
      await emitPatientEvent('patient.visit.conflict_overridden', {
        id: parsed.id,
        patientId: String(visit.patientId),
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        codes: conflictDecision.current.codes,
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
    const before = await requireUndoSnapshot(logEntry.snapshotBefore, scope, 'before')
    const after = await requireUndoSnapshot(logEntry.snapshotAfter, scope, 'after')
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
      await assertVisitEditable(visit)
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
    // Every command reaches its own guard: `makeCrudRoute` only covers the HTTP caller,
    // and a command bus caller (AI tool, CLI, import job, subscriber) bypasses that.
    await requireReferenceFeature(ctx, scope, 'patient.visits.manage')
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
          await assertVisitDeletable(visit)
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
    const before = await requireUndoSnapshot(logEntry.snapshotBefore, scope, 'before')
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
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(409, {
          error: translate('patient.errors.visitUndoStateChanged', 'This visit is no longer deleted; undo was refused'),
          code: 'undo_state_changed',
        })
      }
      if (visit.updatedAt.getTime() <= new Date(before.updatedAt).getTime()) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(409, {
          error: translate(
            'patient.errors.visitUndoVersionMismatch',
            'The deleted visit version is not the one recorded by this action',
          ),
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
  sendPaymentLinkEmail?: boolean
}

export type VisitPaymentLinkFailure = {
  code: string
  message: string
}

export type VisitPaymentActionResult = {
  visit: PatientVisit
  paymentLink: VisitPaymentLink | null
  paymentLinkError: VisitPaymentLinkFailure | null
  paymentLinkEmailQueued?: boolean
  paymentLinkEmailError?: VisitPaymentLinkFailure | null
}

type VisitPaymentLinkEmailService = {
  enqueueForVisit(
    visitId: string,
    paymentLink: VisitPaymentLink,
    ctx: CommandRuntimeContext,
  ): Promise<void>
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

function paymentFailure(error: unknown): VisitPaymentLinkFailure {
  if (error instanceof VisitPaymentLinkError) {
    return { code: error.code, message: error.message }
  }
  if (isCrudHttpError(error)) {
    return {
      code: typeof error.body.code === 'string' ? error.body.code : 'payment_link_failed',
      message: typeof error.body.error === 'string' ? error.body.error : 'The payment link operation failed',
    }
  }
  return { code: 'payment_link_failed', message: 'The payment link operation failed' }
}

function paymentService(ctx: CommandRuntimeContext): VisitPaymentLinkService {
  try {
    return ctx.container.resolve('visitPaymentLinkService') as VisitPaymentLinkService
  } catch {
    throw new CrudHttpError(503, {
      error: 'The visit payment-link service is unavailable',
      code: 'payment_link_service_unavailable',
    })
  }
}

function paymentEmailService(ctx: CommandRuntimeContext): VisitPaymentLinkEmailService {
  try {
    return ctx.container.resolve('visitPaymentLinkEmailService') as VisitPaymentLinkEmailService
  } catch {
    throw new CrudHttpError(503, {
      error: 'The visit payment-link email service is unavailable',
      code: 'payment_link_email_service_unavailable',
    })
  }
}

function unwrapVisitLifecycleResult(result: PatientVisit | VisitPaymentActionResult): PatientVisit {
  return 'visit' in result ? result.visit : result
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
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(503, {
      error: translate(
        'patient.errors.visitAuthorizationUnavailable',
        'The authorization service required for visit actions is unavailable',
      ),
      code: 'visit_authorization_unavailable',
    })
  }
  if (!(await rbac.userHasAllFeatures(userId, required, scope))) {
    const { translate } = await resolveTranslations()
    throw codedForbidden(
      translate('patient.errors.visitActionForbidden', 'You do not have permission to perform this visit action'),
      'visit_action_forbidden',
    )
  }
}

/**
 * Translates a key, falling back to the given English text.
 *
 * A plain default (rather than requiring every caller to resolve one) keeps
 * `assertPatientVisitTransition` synchronous and its table-driven tests unchanged — only the
 * production call site, which already has the request's resolved `translate`, passes one in.
 */
type Translate = (key: string, fallback?: string) => string
const untranslated: Translate = (_key, fallback) => fallback ?? _key

/**
 * Pure transition oracle shared by the command and its table-driven tests.
 * Time never changes a visit automatically; it only gates explicit completion/no-show.
 */
export function assertPatientVisitTransition(
  current: PatientVisitStatus,
  target: PatientVisitStatus,
  startsAt: Date,
  now: Date,
  translate: Translate = untranslated,
): void {
  if (target === 'planned') {
    if (current === 'planned') {
      throw codedConflict(translate('patient.errors.visitStatusUnchanged', 'This visit is already planned'), 'visit_status_unchanged')
    }
    return
  }
  if (current !== 'planned') {
    throw codedConflict(translate('patient.errors.visitTransitionNotAllowed', 'Only a planned visit can be closed'), 'visit_transition_not_allowed')
  }
  if ((target === 'completed' || target === 'no_show') && startsAt.getTime() > now.getTime()) {
    throw new CrudHttpError(422, {
      error: target === 'completed'
        ? translate('patient.errors.visitCompletionBeforeStart', 'A visit cannot be completed before its start time')
        : translate('patient.errors.visitNoShowBeforeStart', 'A patient cannot be marked absent before the visit start time'),
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

async function assertVisitCanBeUnconfirmed(
  em: EntityManager,
  visitId: string,
  scope: PatientScope,
): Promise<void> {
  const custom = await loadCustomFieldValues({
    em,
    entityId: PATIENT_VISIT_ENTITY_ID,
    recordIds: [visitId],
    tenantIdByRecord: { [visitId]: scope.tenantId },
    organizationIdByRecord: { [visitId]: scope.organizationId },
  })
  const values = (custom[visitId] ?? {}) as Record<string, unknown>
  const paymentStatus = values.cf_payment_link_status
    ?? values['cf:payment_link_status']
    ?? values.payment_link_status
  const paymentReceivedAt = values.cf_payment_received_at
    ?? values['cf:payment_received_at']
    ?? values.payment_received_at
  if (paymentStatus === 'completed' || (typeof paymentReceivedAt === 'string' && paymentReceivedAt.trim())) {
    throw codedConflict('A paid visit cannot be unconfirmed', 'visit_already_paid')
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
  const { translate } = await resolveTranslations()

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
        if (operation === 'unconfirm') {
          await assertVisitCanBeUnconfirmed(phaseEm, input.id, scope)
        }
        updatedAt = nextUpdatedAt(patient.updatedAt > visit.updatedAt ? patient.updatedAt : visit.updatedAt)
      },
      ({ em: phaseEm }) => {
        if (operation === 'confirm' || operation === 'unconfirm') {
          if (visit.status !== 'planned') {
            throw codedConflict(
              translate('patient.errors.visitConfirmationNotApplicable', 'Confirmation can only be changed for a planned visit'),
              'visit_confirmation_not_applicable',
            )
          }
          const shouldConfirm = operation === 'confirm'
          if (Boolean(visit.confirmedAt) === shouldConfirm) {
            throw codedConflict(
              translate('patient.errors.visitConfirmationUnchanged', 'The visit confirmation already has this value'),
              'visit_confirmation_unchanged',
            )
          }
          visit.confirmedAt = shouldConfirm ? updatedAt : null
          visit.confirmedByUserId = shouldConfirm ? actorUserId : null
        } else if (operation === 'transition') {
          const target = input.status
          if (!target) throw new Error('[internal] Missing parsed visit target status')
          assertPatientVisitTransition(visit.status, target, visit.startsAt, wallClockNow, translate)
          if (target === 'planned') assertPatientAcceptsNewEntries(patient)
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
            throw codedConflict(
              translate('patient.errors.visitSettlementUnchanged', 'The visit settlement already has this value'),
              'visit_settlement_unchanged',
            )
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
): CommandHandler<Record<string, unknown>, PatientVisit | VisitPaymentActionResult> {
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
      const visit = await executeVisitLifecycleAction(input, ctx, definition.operation)
      if (definition.operation !== 'confirm' && definition.operation !== 'unconfirm') return visit

      let paymentLink: VisitPaymentLink | null = null
      let paymentLinkError: VisitPaymentLinkFailure | null = null
      let paymentLinkEmailQueued = false
      let paymentLinkEmailError: VisitPaymentLinkFailure | null = null
      try {
        paymentLink = definition.operation === 'confirm'
          ? await paymentService(ctx).ensureForVisit(input.id, ctx, visit.updatedAt.toISOString())
          : await paymentService(ctx).deactivateForVisit(input.id, ctx)
      } catch (error) {
        // Confirmation/unconfirmation is already committed. Checkout is an
        // explicitly isolated post-commit effect and is reported for safe retry.
        paymentLinkError = paymentFailure(error)
      }

      if (definition.operation === 'confirm' && input.sendPaymentLinkEmail && paymentLink) {
        try {
          await paymentEmailService(ctx).enqueueForVisit(input.id, paymentLink, ctx)
          paymentLinkEmailQueued = true
        } catch (error) {
          paymentLinkEmailError = paymentFailure(error)
        }
      }

      return {
        visit,
        paymentLink,
        paymentLinkError,
        ...(input.sendPaymentLinkEmail
          ? { paymentLinkEmailQueued, paymentLinkEmailError }
          : {}),
      }
    },
    async captureAfter(_rawInput, result, ctx) {
      return lifecycleSnapshot(unwrapVisitLifecycleResult(result), requirePatientScope(ctx))
    },
    async buildLog({ input: rawInput, result, snapshots }) {
      const input = definition.parse(rawInput)
      const visit = unwrapVisitLifecycleResult(result)
      const { translate } = await resolveTranslations()
      return {
        actionLabel: translate(definition.labelKey, definition.label),
        resourceKind: 'patient.patient_visit',
        resourceId: String(visit.id),
        parentResourceKind: 'patient.patient',
        parentResourceId: String(visit.patientId),
        tenantId: String(visit.tenantId),
        organizationId: String(visit.organizationId),
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
  parse: (input) => patientVisitConfirmActionSchema.parse(input),
})

const unconfirmVisitCommand = createVisitLifecycleCommand({
  id: 'patient.visits.unconfirm',
  operation: 'unconfirm',
  labelKey: 'patient.audit.visits.unconfirm',
  label: 'Unconfirm visit',
  parse: (input) => patientVisitUnconfirmActionSchema.parse(input),
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

function rethrowPaymentActionError(error: unknown): never {
  if (isCrudHttpError(error)) throw error
  if (error instanceof VisitPaymentLinkError) {
    const status = error.code === 'visit_already_paid'
      ? 409
      : error.code.endsWith('_missing') || error.code.endsWith('_ambiguous')
        ? 503
        : 422
    throw new CrudHttpError(status, { error: error.message, code: error.code })
  }
  throw new CrudHttpError(503, {
    error: 'The payment-link operation could not be completed',
    code: 'payment_link_failed',
  })
}

async function paymentActionVisit(
  ctx: CommandRuntimeContext,
  visitId: string,
): Promise<PatientVisit> {
  const scope = requirePatientScope(ctx)
  return await loadVisitDecrypted(
    (ctx.container.resolve('em') as EntityManager).fork(),
    visitId,
    scope,
  )
}

const ensureVisitPaymentLinkCommand: CommandHandler<Record<string, unknown>, VisitPaymentActionResult> = {
  id: 'patient.visits.ensurePaymentLink',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = patientVisitEnsurePaymentLinkActionSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    requireActorUserId(ctx)
    await requireVisitFeatures(ctx, scope, ['patient.visits.manage'])
    try {
      const paymentLink = await paymentService(ctx).ensureForVisit(input.id, ctx, input.expectedUpdatedAt)
      return {
        visit: await paymentActionVisit(ctx, input.id),
        paymentLink,
        paymentLinkError: null,
      }
    } catch (error) {
      rethrowPaymentActionError(error)
    }
  },
}

const sendVisitPaymentLinkEmailCommand: CommandHandler<Record<string, unknown>, VisitPaymentActionResult> = {
  id: 'patient.visits.sendPaymentLinkEmail',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = patientVisitSendPaymentLinkEmailActionSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    requireActorUserId(ctx)
    await requireVisitFeatures(ctx, scope, ['patient.visits.manage'])
    try {
      const paymentLink = await paymentService(ctx).ensureForVisit(input.id, ctx, input.expectedUpdatedAt)
      await paymentEmailService(ctx).enqueueForVisit(input.id, paymentLink, ctx)
      return {
        visit: await paymentActionVisit(ctx, input.id),
        paymentLink,
        paymentLinkError: null,
        paymentLinkEmailQueued: true,
        paymentLinkEmailError: null,
      }
    } catch (error) {
      rethrowPaymentActionError(error)
    }
  },
}

registerCommand(createVisitCommand)
registerCommand(updateVisitCommand)
registerCommand(deleteVisitCommand)
registerCommand(confirmVisitCommand)
registerCommand(unconfirmVisitCommand)
registerCommand(transitionVisitCommand)
registerCommand(settleVisitCommand)
registerCommand(unsettleVisitCommand)
registerCommand(ensureVisitPaymentLinkCommand)
registerCommand(sendVisitPaymentLinkEmailCommand)
