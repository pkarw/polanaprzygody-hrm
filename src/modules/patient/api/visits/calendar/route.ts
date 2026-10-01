import { NextResponse } from 'next/server'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { Patient, PatientVisit } from '../../../data/entities'
import { patientVisitCalendarQuerySchema } from '../../../data/validators'
import type {
  PatientAvailabilityService,
  PlannerAvailabilityService,
} from '../../../lib/patientAvailabilityService'
import type { PatientReferenceService } from '../../../lib/patientReferenceService'
import type { VisitSubjectAvailability } from '../../../lib/visitConflicts'
import { VISIT_CONFLICT_CODES } from '../../../lib/visitConflicts'
import { readPatientCalendarStore } from '../../../lib/patientCalendarStorage'
import type {
  PatientVisitAvailabilityLane,
  PatientVisitAvailabilityLaneWindow,
  PatientVisitCalendarDegradation,
  PatientVisitCalendarItem,
} from '../../../types'
import { buildPatientRouteContext, toPatientErrorResponse } from '../../../lib/routeSupport'
import {
  patientErrorSchema,
  patientTag,
  patientVisitCalendarResponseSchema,
} from '../../openapi'

const PATIENT_VISIT_CALENDAR_MAX_ITEMS = 2_000

type ScopedRbacService = {
  userHasAllFeatures(
    userId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ): Promise<boolean>
}

export const metadata = {
  GET: {
    requireAuth: true,
    requireFeatures: ['patient.visits.view', 'patient.patients.view'],
  },
}

function queryInput(request: Request): Record<string, string> {
  const url = new URL(request.url)
  return Object.fromEntries(Array.from(url.searchParams.entries()).filter(([, value]) => value.length > 0))
}

function commandScope(ctx: CommandRuntimeContext): { tenantId: string; organizationId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!tenantId || !organizationId) {
    throw new CrudHttpError(400, { error: 'A tenant and organization scope are required' })
  }
  return { tenantId, organizationId }
}

async function canViewHostReason(
  ctx: CommandRuntimeContext,
  scope: { tenantId: string; organizationId: string },
  feature: string,
): Promise<boolean> {
  const userId = ctx.auth?.sub ?? null
  if (!userId) return false
  try {
    const rbac = ctx.container.resolve('rbacService') as ScopedRbacService
    return await rbac.userHasAllFeatures(userId, [feature], scope)
  } catch {
    return false
  }
}

function calendarLanes(subjects: VisitSubjectAvailability[]): {
  lanes: PatientVisitAvailabilityLane[]
  degraded: PatientVisitCalendarDegradation[]
} {
  const lanes: PatientVisitAvailabilityLane[] = []
  const degraded: PatientVisitCalendarDegradation[] = []
  for (const subject of subjects) {
    const laneWindows: PatientVisitAvailabilityLaneWindow[] = []
    if (subject.unknown) {
      degraded.push({
        code: 'availability_unknown',
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        subjectName: subject.subjectName,
      })
    }
    const append = (
      kind: PatientVisitAvailabilityLaneWindow['kind'],
      subjectWindows: VisitSubjectAvailability['availableWindows'],
    ) => {
      subjectWindows.forEach((window, index) => {
        const from = window.start.toISOString()
        const to = window.end.toISOString()
        laneWindows.push({
          id: `${subject.subjectType}:${subject.subjectId}:${kind}:${from}:${to}:${index}`,
          kind,
          from,
          to,
          ...(window.reasonLabel ? { reasonLabel: window.reasonLabel } : {}),
        })
      })
    }
    append('availability', subject.availableWindows)
    append('exception', subject.unavailableWindows)
    lanes.push({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      subjectName: subject.subjectName,
      hasSchedule: subject.hasSchedule,
      ...(subject.isActive !== undefined ? { isActive: subject.isActive } : {}),
      unknown: subject.unknown === true,
      windows: laneWindows,
    })
  }
  return { lanes, degraded }
}

export async function GET(request: Request) {
  let translateFn: (key: string, fallback?: string) => string = (_key, fallback) => fallback ?? ''
  try {
    const { ctx, translate } = await buildPatientRouteContext(request)
    translateFn = translate
    const parsed = patientVisitCalendarQuerySchema.parse(queryInput(request))
    const scope = commandScope(ctx)
    const from = new Date(parsed.from)
    const to = new Date(parsed.to)
    const em = ctx.container.resolve<EntityManager>('em')
    const where: FilterQuery<PatientVisit> = {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
      ...(parsed.patientId ? { patientId: parsed.patientId } : {}),
      ...(parsed.teamMemberId ? { teamMemberId: parsed.teamMemberId } : {}),
      ...(parsed.resourceId ? { resourceId: parsed.resourceId } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
      $and: [{
        startsAt: { $lt: to },
        $or: [
          { endsAt: { $gt: from } },
          { endsAt: null, startsAt: { $gte: from } },
        ],
      }],
    }
    const visits = await readPatientCalendarStore(() => findWithDecryption(
      em,
      PatientVisit,
      where,
      {
        fields: [
          'id',
          'patientId',
          'teamMemberId',
          'teamMemberNameSnapshot',
          'resourceId',
          'resourceNameSnapshot',
          'startsAt',
          'endsAt',
          'timeZone',
          'status',
          'confirmedAt',
          'isSettled',
          'conflictOverrideAt',
          'conflictOverrideCodes',
          'updatedAt',
        ],
        orderBy: { startsAt: 'asc', id: 'asc' },
        limit: PATIENT_VISIT_CALENDAR_MAX_ITEMS + 1,
      },
      scope,
    ))
    if (visits.length > PATIENT_VISIT_CALENDAR_MAX_ITEMS) {
      throw new CrudHttpError(400, {
        // Localized: `raiseCrudError` surfaces this body's `error` as the thrown message and
        // `VisitsCalendar` renders it verbatim, so a Polish practice would otherwise read
        // English. The machine-readable `code` stays stable for clients.
        error: translate(
          'patient.errors.calendarTooManyItems',
          'The calendar contains too many visits; narrow the range or add a filter',
        ),
        code: 'visit_calendar_too_many_items',
        maxItems: PATIENT_VISIT_CALENDAR_MAX_ITEMS,
      })
    }
    const patientIds = Array.from(new Set(visits.map((visit) => String(visit.patientId))))
    const patients = patientIds.length > 0
      ? await readPatientCalendarStore(() => findWithDecryption(
          em,
          Patient,
          {
            id: { $in: patientIds },
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
          } as FilterQuery<Patient>,
          { fields: ['id', 'firstName', 'lastName'] },
          scope,
        ))
      : []
    const patientNames = new Map(patients.map((patient) => {
      const name = [patient.firstName, patient.lastName].filter(Boolean).join(' ').trim()
      return [String(patient.id), name || null] as const
    }))
    const allowedConflictCodes = new Set<string>(VISIT_CONFLICT_CODES)
    const items: PatientVisitCalendarItem[] = visits.map((visit) => ({
      id: String(visit.id),
      patientId: String(visit.patientId),
      patientName: patientNames.get(String(visit.patientId)) ?? null,
      teamMemberId: String(visit.teamMemberId),
      teamMemberName: String(visit.teamMemberNameSnapshot),
      resourceId: visit.resourceId ?? null,
      resourceName: visit.resourceNameSnapshot ?? null,
      startsAt: visit.startsAt.toISOString(),
      endsAt: visit.endsAt?.toISOString() ?? null,
      timeZone: visit.timeZone,
      status: visit.status,
      confirmedAt: visit.confirmedAt?.toISOString() ?? null,
      isSettled: visit.isSettled,
      conflictOverrideAt: visit.conflictOverrideAt?.toISOString() ?? null,
      conflictOverrideCodes: Array.isArray(visit.conflictOverrideCodes)
        ? visit.conflictOverrideCodes.filter((code) => allowedConflictCodes.has(code))
        : null,
      updatedAt: visit.updatedAt.toISOString(),
    }))

    const references = ctx.container.resolve('patientReferenceService') as PatientReferenceService
    const [members, resources, exposeMemberReason, exposeResourceReason] = await Promise.all([
      parsed.teamMemberId ? references.resolveTeamMembers([parsed.teamMemberId], scope) : Promise.resolve(new Map()),
      parsed.resourceId ? references.resolveResources([parsed.resourceId], scope) : Promise.resolve(new Map()),
      canViewHostReason(ctx, scope, 'staff.view'),
      canViewHostReason(ctx, scope, 'resources.view'),
    ])
    const member = parsed.teamMemberId ? members.get(parsed.teamMemberId) ?? null : null
    const resource = parsed.resourceId ? resources.get(parsed.resourceId) ?? null : null
    let planner: PlannerAvailabilityService | null = null
    try {
      planner = ctx.container.resolve('plannerAvailabilityService') as PlannerAvailabilityService
    } catch {
      planner = null
    }
    const availability = ctx.container.resolve('patientAvailabilityService') as PatientAvailabilityService
    const subjects = await availability.getSubjectAvailability({
      scope,
      range: { start: from, end: to },
      ...(member ? {
        teamMember: {
          id: member.id,
          name: member.displayName,
          exposeReason: exposeMemberReason,
        },
      } : {}),
      ...(resource ? {
        resource: {
          id: resource.id,
          name: resource.displayName,
          exposeReason: exposeResourceReason,
        },
      } : {}),
      plannerAvailabilityService: planner,
    })
    const { lanes, degraded } = calendarLanes(subjects)
    return NextResponse.json({
      items,
      lanes,
      degraded,
      range: { from: from.toISOString(), to: to.toISOString() },
    })
  } catch (error) {
    return toPatientErrorResponse(error, translateFn, 'visits.calendar')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'List patient visits in a bounded calendar range',
  methods: {
    GET: {
      summary: 'Read scoped calendar visits and selected availability lanes',
      description: 'Returns visits overlapping a range of at most 62 days. Availability lanes are returned only for in-scope therapist or room filters; planner failures degrade explicitly without widening scope.',
      tags: [patientTag],
      query: patientVisitCalendarQuerySchema,
      responses: [
        { status: 200, description: 'Calendar visits, selected availability lanes, and degradation notes.', schema: patientVisitCalendarResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Invalid scope, timestamps, filters, or a range exceeding 62 days', schema: patientErrorSchema },
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'Visit or patient view access is not granted', schema: patientErrorSchema },
        { status: 503, description: 'The patient calendar data store is unavailable', schema: patientErrorSchema },
      ],
    },
  },
}
