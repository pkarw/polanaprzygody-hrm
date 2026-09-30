import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { tryGetModules } from '@open-mercato/shared/lib/modules/registry'
import { PatientVisit } from '../data/entities'
import type { PatientReferenceScope } from './patientReferenceService'
import type {
  OverlappingVisit,
  VisitConflictDraft,
  VisitConflictSubjectType,
  VisitSubjectAvailability,
} from './visitConflicts'

type AvailabilityRule = {
  id: string
  subjectType: 'member' | 'resource' | 'ruleset'
  subjectId: string
  rrule: string
  exdates: string[]
  kind: 'availability' | 'unavailability'
  reasonEntryId: string | null
  reasonValue: string | null
}

type PlannerAvailabilityService = {
  getMergedAvailabilityWindows(params: {
    rules: Array<{
      id?: string
      rrule: string
      exdates?: string[]
      kind?: 'availability' | 'unavailability'
    }>
    range: { start: Date; end: Date }
  }): Array<{ start: Date; end: Date; ruleId?: string }>
}

export type PatientAvailabilityQuery = {
  scope: PatientReferenceScope
  range: { start: Date; end: Date }
  teamMember?: { id: string; name: string; exposeReason?: boolean }
  resource?: { id: string; name: string; exposeReason?: boolean }
  plannerAvailabilityService?: PlannerAvailabilityService | null
}

export type PatientAvailabilityService = {
  getSubjectAvailability(query: PatientAvailabilityQuery): Promise<VisitSubjectAvailability[]>
  findOverlappingVisits(input: {
    scope: PatientReferenceScope
    draft: VisitConflictDraft
    excludeVisitId?: string
    em?: EntityManager
  }): Promise<OverlappingVisit[]>
}

function readText(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function readNullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toRule(row: Record<string, unknown>): AvailabilityRule | null {
  const id = readText(row, 'id')
  const subjectType = readText(row, 'subject_type')
  const subjectId = readText(row, 'subject_id')
  const rrule = readText(row, 'rrule')
  const kind = readText(row, 'kind')
  if (!id || !subjectId || !rrule) return null
  if (subjectType !== 'member' && subjectType !== 'resource' && subjectType !== 'ruleset') return null
  if (kind !== 'availability' && kind !== 'unavailability') return null
  return {
    id,
    subjectType,
    subjectId,
    rrule,
    exdates: Array.isArray(row.exdates)
      ? row.exdates.filter((value): value is string => typeof value === 'string')
      : [],
    kind,
    reasonEntryId: readNullableText(row, 'unavailability_reason_entry_id'),
    reasonValue: readNullableText(row, 'unavailability_reason_value'),
  }
}

function plannerEnabled(): boolean {
  const modules = tryGetModules()
  return modules === null || modules.some((module) => module.id === 'planner')
}

export function createPatientAvailabilityService(
  em: EntityManager,
  queryEngine: QueryEngine,
): PatientAvailabilityService {
  async function queryRules(
    scope: PatientReferenceScope,
    subjectIds: string[],
  ): Promise<AvailabilityRule[]> {
    if (subjectIds.length === 0) return []
    const { items } = await queryEngine.query<Record<string, unknown>>(
      'planner:planner_availability_rule',
      {
        fields: [
          'id',
          'subject_type',
          'subject_id',
          'rrule',
          'exdates',
          'kind',
          'unavailability_reason_entry_id',
          'unavailability_reason_value',
        ],
        filters: { subject_id: { $in: subjectIds } },
        page: { page: 1, pageSize: 100 },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      },
    )
    return items.map(toRule).filter((rule): rule is AvailabilityRule => rule !== null)
  }

  async function readResource(
    scope: PatientReferenceScope,
    id: string,
  ): Promise<{ isActive: boolean; ruleSetId: string | null } | null> {
    const { items } = await queryEngine.query<Record<string, unknown>>(
      'resources:resources_resource',
      {
        fields: ['id', 'is_active', 'deleted_at', 'availability_rule_set_id'],
        filters: { id },
        page: { page: 1, pageSize: 1 },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        withDeleted: true,
      },
    )
    const row = items[0]
    if (!row || readText(row, 'id') !== id) return null
    return {
      isActive: row.is_active !== false && row.deleted_at == null,
      ruleSetId: readNullableText(row, 'availability_rule_set_id'),
    }
  }

  function mergeSubject(
    subjectType: VisitConflictSubjectType,
    subjectId: string,
    subjectName: string,
    directRules: AvailabilityRule[],
    ruleSetRules: AvailabilityRule[],
    query: PatientAvailabilityQuery,
    isActive?: boolean,
    exposeReason?: boolean,
  ): VisitSubjectAvailability {
    const planner = query.plannerAvailabilityService
    if (!planner) {
      return {
        subjectType,
        subjectId,
        subjectName,
        hasSchedule: false,
        isActive,
        unknown: true,
        availableWindows: [],
        unavailableWindows: [],
      }
    }

    const directAvailability = directRules.filter((rule) => rule.kind === 'availability')
    const baseAvailability = directAvailability.length > 0
      ? directAvailability
      : ruleSetRules.filter((rule) => rule.kind === 'availability')
    const blockers = [
      ...ruleSetRules.filter((rule) => rule.kind === 'unavailability'),
      ...directRules.filter((rule) => rule.kind === 'unavailability'),
    ]
    const effectiveRules = [...baseAvailability, ...blockers]
    const availableWindows = planner.getMergedAvailabilityWindows({
      rules: effectiveRules,
      range: query.range,
    }).map((window) => ({ start: window.start, end: window.end }))
    const unavailableWindows = blockers.flatMap((rule) => planner
      .getMergedAvailabilityWindows({
        rules: [{ ...rule, kind: 'availability' }],
        range: query.range,
      })
      .map((window) => ({
        start: window.start,
        end: window.end,
        reasonKind: rule.reasonEntryId || rule.reasonValue ? 'leave' as const : 'manual' as const,
        ...(exposeReason && rule.reasonValue ? { reasonLabel: rule.reasonValue } : {}),
      })))

    return {
      subjectType,
      subjectId,
      subjectName,
      hasSchedule: baseAvailability.length > 0,
      isActive,
      availableWindows,
      unavailableWindows,
    }
  }

  return {
    async findOverlappingVisits(input) {
      const targetEm = input.em ?? em
      const subjectFilter: FilterQuery<PatientVisit>[] = [
        { teamMemberId: input.draft.teamMemberId },
      ]
      if (input.draft.resourceId) subjectFilter.push({ resourceId: input.draft.resourceId })
      const timeFilter: FilterQuery<PatientVisit> = input.draft.endsAt
        ? {
            startsAt: { $lt: input.draft.endsAt },
            $or: [
              { endsAt: { $gt: input.draft.startsAt } },
              { endsAt: null, startsAt: { $gte: input.draft.startsAt } },
            ],
          }
        : {
            $or: [
              { startsAt: { $lte: input.draft.startsAt }, endsAt: { $gt: input.draft.startsAt } },
              { startsAt: input.draft.startsAt, endsAt: null },
            ],
          }
      const where: FilterQuery<PatientVisit> = {
        tenantId: input.scope.tenantId,
        organizationId: input.scope.organizationId,
        deletedAt: null,
        status: { $ne: 'cancelled' },
        $and: [{ $or: subjectFilter }, timeFilter],
      }
      if (input.excludeVisitId) where.id = { $ne: input.excludeVisitId }
      const visits = await targetEm.find(PatientVisit, where, {
        fields: ['id', 'teamMemberId', 'resourceId', 'startsAt', 'endsAt'],
        orderBy: { startsAt: 'asc', id: 'asc' },
      })
      return visits.map((visit) => ({
        id: String(visit.id),
        teamMemberId: String(visit.teamMemberId),
        resourceId: visit.resourceId ?? null,
        startsAt: visit.startsAt,
        endsAt: visit.endsAt ?? null,
      }))
    },
    async getSubjectAvailability(query) {
      let resourceState: { isActive: boolean; ruleSetId: string | null } | null = null
      if (query.resource) {
        resourceState = await readResource(query.scope, query.resource.id)
      }
      if (!plannerEnabled() || !query.plannerAvailabilityService) {
        return [
          ...(query.teamMember ? [mergeSubject(
            'member', query.teamMember.id, query.teamMember.name, [], [], query,
            undefined, query.teamMember.exposeReason,
          )] : []),
          ...(query.resource ? [mergeSubject(
            'resource', query.resource.id, query.resource.name, [], [], query,
            resourceState?.isActive ?? false, query.resource.exposeReason,
          )] : []),
        ]
      }

      const directIds = [query.teamMember?.id, query.resource?.id].filter((id): id is string => Boolean(id))
      const ruleSetIds = resourceState?.ruleSetId ? [resourceState.ruleSetId] : []
      try {
        const rules = await queryRules(query.scope, [...directIds, ...ruleSetIds])
        return [
          ...(query.teamMember ? [mergeSubject(
            'member',
            query.teamMember.id,
            query.teamMember.name,
            rules.filter((rule) => rule.subjectType === 'member' && rule.subjectId === query.teamMember?.id),
            [],
            query,
            undefined,
            query.teamMember.exposeReason,
          )] : []),
          ...(query.resource ? [mergeSubject(
            'resource',
            query.resource.id,
            query.resource.name,
            rules.filter((rule) => rule.subjectType === 'resource' && rule.subjectId === query.resource?.id),
            rules.filter((rule) => rule.subjectType === 'ruleset' && rule.subjectId === resourceState?.ruleSetId),
            query,
            resourceState?.isActive ?? false,
            query.resource.exposeReason,
          )] : []),
        ]
      } catch {
        return [
          ...(query.teamMember ? [mergeSubject(
            'member', query.teamMember.id, query.teamMember.name, [], [],
            { ...query, plannerAvailabilityService: null }, undefined, query.teamMember.exposeReason,
          )] : []),
          ...(query.resource ? [mergeSubject(
            'resource', query.resource.id, query.resource.name, [], [],
            { ...query, plannerAvailabilityService: null }, resourceState?.isActive ?? false,
            query.resource.exposeReason,
          )] : []),
        ]
      }
    },
  }
}
