import type { EntityManager } from '@mikro-orm/postgresql'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { decryptEntitiesWithFallbackScope } from '@open-mercato/shared/lib/encryption/subscriber'
import { PatientVisit } from '../data/entities'
import { toIsoTimestamp } from './commandSupport'

type ScopedRbacService = {
  userHasAllFeatures(
    userId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ): Promise<boolean>
}

export type PatientNextVisitTarget = {
  id: string
  nextVisit?: {
    startsAt: string
    timeZone: string
    resourceNameSnapshot: string | null
    confirmedAt: string | null
  } | null
}

/** Free text belongs only to an explicit single-record lookup, never to `ids` lists. */
export function isVisitDetailQuery(query: { id?: string; ids?: string }): boolean {
  return typeof query.id === 'string' && query.id.length > 0
}

/**
 * Adds the nearest future planned visit with one scoped DISTINCT ON query for a page.
 *
 * Authorization is checked on every call (including cache hits). A missing scope, actor,
 * RBAC service, or grant removes a pre-existing value so a cached enrichment cannot leak.
 */
export async function enrichPatientNextVisits(
  items: PatientNextVisitTarget[],
  ctx: CrudCtx,
  now: Date = new Date(),
): Promise<void> {
  if (items.length === 0) return
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  const userId = ctx.auth?.sub ?? null

  let canViewVisits = false
  if (tenantId && organizationId && userId) {
    try {
      const rbac = ctx.container.resolve<ScopedRbacService>('rbacService')
      canViewVisits = await rbac.userHasAllFeatures(userId, ['patient.visits.view'], {
        tenantId,
        organizationId,
      })
    } catch {
      canViewVisits = false
    }
  }
  if (!canViewVisits || !tenantId || !organizationId) {
    for (const item of items) delete item.nextVisit
    return
  }

  const em = ctx.container.resolve<EntityManager>('em')
  const visits = await em
    .createQueryBuilder(PatientVisit, 'visit')
    .select([
      'visit.id',
      'visit.patientId',
      'visit.startsAt',
      'visit.timeZone',
      'visit.resourceNameSnapshot',
      'visit.confirmedAt',
    ])
    .distinctOn('visit.patientId')
    .where({
      patientId: { $in: items.map((item) => item.id) },
      tenantId,
      organizationId,
      status: 'planned',
      startsAt: { $gte: now },
      deletedAt: null,
    })
    .orderBy({ patientId: 'asc', startsAt: 'asc', id: 'asc' })
    .getResultList()
  await decryptEntitiesWithFallbackScope(visits, { em, tenantId, organizationId })

  const nextByPatient = new Map<string, (typeof visits)[number]>()
  for (const visit of visits) {
    if (!nextByPatient.has(String(visit.patientId))) {
      nextByPatient.set(String(visit.patientId), visit)
    }
  }
  for (const item of items) {
    const visit = nextByPatient.get(item.id)
    item.nextVisit = visit
      ? {
          startsAt: visit.startsAt.toISOString(),
          timeZone: visit.timeZone,
          resourceNameSnapshot: visit.resourceNameSnapshot ?? null,
          confirmedAt: toIsoTimestamp(visit.confirmedAt),
        }
      : null
  }
}
