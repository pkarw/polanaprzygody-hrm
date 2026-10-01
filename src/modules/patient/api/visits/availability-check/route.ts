import { NextResponse } from 'next/server'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { patientVisitAvailabilityCheckQuerySchema } from '../../../data/validators'
import type {
  PatientAvailabilityService,
  PlannerAvailabilityService,
} from '../../../lib/patientAvailabilityService'
import type { PatientReferenceService } from '../../../lib/patientReferenceService'
import {
  evaluateVisitConflicts,
  redactVisitConflictsForRead,
  worstVisitConflictSeverity,
} from '../../../lib/visitConflicts'
import {
  buildPatientRouteContext,
  toPatientErrorResponse,
} from '../../../lib/routeSupport'
import {
  patientErrorSchema,
  patientTag,
  patientVisitAvailabilityCheckResponseSchema,
} from '../../openapi'

type ScopedRbacService = {
  userHasAllFeatures(
    userId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ): Promise<boolean>
}

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['patient.visits.manage'] },
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

export async function GET(request: Request) {
  let translateFn: (key: string, fallback?: string) => string = (_key, fallback) => fallback ?? ''
  try {
    const { ctx, translate } = await buildPatientRouteContext(request)
    translateFn = translate
    const parsed = patientVisitAvailabilityCheckQuerySchema.parse(queryInput(request))
    const scope = commandScope(ctx)
    const references = ctx.container.resolve('patientReferenceService') as PatientReferenceService
    const availability = ctx.container.resolve('patientAvailabilityService') as PatientAvailabilityService
    const [teamMember, resources, exposeMemberReason, exposeResourceReason] = await Promise.all([
      references.requireActiveTeamMember(parsed.teamMemberId, scope),
      parsed.resourceId ? references.resolveResources([parsed.resourceId], scope) : Promise.resolve(new Map()),
      canViewHostReason(ctx, scope, 'staff.view'),
      canViewHostReason(ctx, scope, 'resources.view'),
    ])
    const resource = parsed.resourceId ? resources.get(parsed.resourceId) ?? null : null
    if (parsed.resourceId && !resource) {
      throw new CrudHttpError(422, {
        error: 'A selected visit reference is unavailable',
        code: 'visit_reference_unavailable',
      })
    }
    let planner: PlannerAvailabilityService | null = null
    try {
      planner = ctx.container.resolve('plannerAvailabilityService') as PlannerAvailabilityService
    } catch {
      planner = null
    }
    const draft = {
      teamMemberId: parsed.teamMemberId,
      teamMemberName: teamMember.displayName,
      resourceId: parsed.resourceId ?? null,
      resourceName: resource?.displayName ?? null,
      startsAt: new Date(parsed.startsAt),
      endsAt: parsed.endsAt ? new Date(parsed.endsAt) : null,
    }
    const [subjects, overlappingVisits] = await Promise.all([
      availability.getSubjectAvailability({
        scope,
        range: {
          start: draft.startsAt,
          end: draft.endsAt ?? new Date(draft.startsAt.getTime() + 60_000),
        },
        teamMember: {
          id: parsed.teamMemberId,
          name: teamMember.displayName,
          exposeReason: exposeMemberReason,
        },
        ...(parsed.resourceId ? {
          resource: {
            id: parsed.resourceId,
            name: resource?.displayName ?? '',
            exposeReason: exposeResourceReason,
            // Already resolved here, so a degraded resource read inside the service cannot
            // downgrade a known-inactive room to a non-blocking `availability_unknown`.
            isActive: resource?.isAvailable,
          },
        } : {}),
        plannerAvailabilityService: planner,
      }),
      availability.findOverlappingVisits({
        scope,
        draft,
        excludeVisitId: parsed.excludeVisitId,
      }),
    ])
    const conflicts = redactVisitConflictsForRead(
      evaluateVisitConflicts({ draft, subjects, overlappingVisits }),
      { exposeMemberReason, exposeResourceReason },
    )
    return NextResponse.json({
      conflicts,
      worstSeverity: worstVisitConflictSeverity(conflicts),
      checkedAt: new Date().toISOString(),
    })
  } catch (error) {
    return toPatientErrorResponse(error, translateFn, 'visits.availabilityCheck')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Check patient visit availability',
  methods: {
    GET: {
      summary: 'Check therapist and room availability for a visit',
      description: 'Returns the same scoped conflict matrix recalculated by visit create and update commands. The result is advisory; writes always recalculate it after acquiring schedule locks.',
      tags: [patientTag],
      query: patientVisitAvailabilityCheckQuerySchema,
      responses: [
        { status: 200, description: 'Current availability conflicts and their exact acknowledgement signatures.', schema: patientVisitAvailabilityCheckResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Invalid timestamp, scope, or half-open interval', schema: patientErrorSchema },
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'patient.visits.manage is not granted', schema: patientErrorSchema },
        { status: 422, description: 'A selected reference is not available in scope', schema: patientErrorSchema },
        { status: 503, description: 'A required patient data service is unavailable', schema: patientErrorSchema },
      ],
    },
  },
}
