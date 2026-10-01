import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'
import { patientVisitCalendarResponseSchema } from '../api/openapi'
import { readPatientCalendarStore } from '../lib/patientCalendarStorage'
import { patientVisitCalendarQuerySchema } from '../data/validators'

const id = (value: number) => `${String(value).repeat(8)}-aaaa-4bbb-8ccc-dddddddddddd`
const routeSource = readFileSync(
  path.join(__dirname, '..', 'api', 'visits', 'calendar', 'route.ts'),
  'utf8',
)

describe('patient visit calendar route', () => {
  it('maps patient-owned storage failures to the documented stable 503', async () => {
    await expect(readPatientCalendarStore(async () => {
      throw new Error('database detail that must not escape')
    })).rejects.toMatchObject({
      status: 503,
      body: {
        error: 'The patient calendar data store is unavailable',
        code: 'visit_calendar_store_unavailable',
      },
    })
  })

  /**
   * The stable 503 previously made the failure invisible: a `CrudHttpError` bypasses
   * `toPatientErrorResponse`'s `logger.error` branch, so a permanent fault — an undecryptable
   * row after a key rotation — looked like a retryable blip with no trace anywhere. It is
   * logged now, but by error CLASS only: a driver message can quote the offending row, and
   * these rows hold clinical data.
   */
  it('records the failure class without putting a database fragment in the log', () => {
    const source = readFileSync(
      path.join(__dirname, '..', 'lib', 'patientCalendarStorage.ts'),
      'utf8',
    )
    expect(source).toContain('logger.error(')
    expect(source).toContain('errorName:')
    expect(source).not.toContain('error.message')
  })

  it('accepts a 62-day range and rejects reversed, wider, offset-free, and scoped inputs', () => {
    const valid = {
      from: '2026-09-01T00:00:00Z',
      to: '2026-11-02T00:00:00Z',
      teamMemberId: id(1),
      resourceId: id(2),
      patientId: id(3),
      status: 'planned',
    } as const
    expect(patientVisitCalendarQuerySchema.safeParse(valid).success).toBe(true)
    expect(patientVisitCalendarQuerySchema.safeParse({ ...valid, to: '2026-11-02T00:00:01Z' }).success).toBe(false)
    expect(patientVisitCalendarQuerySchema.safeParse({ ...valid, to: valid.from }).success).toBe(false)
    expect(patientVisitCalendarQuerySchema.safeParse({ ...valid, from: '2026-09-01T00:00:00' }).success).toBe(false)
    expect(patientVisitCalendarQuerySchema.safeParse({ ...valid, tenantId: id(4) }).success).toBe(false)
  })

  it('publishes a clinical-detail-free calendar, lane, and degradation response', () => {
    const result = patientVisitCalendarResponseSchema.parse({
      items: [{
        id: id(1),
        patientId: id(2),
        patientName: 'Jan Kowalski',
        teamMemberId: id(3),
        teamMemberName: 'Anna Nowicka',
        resourceId: id(4),
        resourceName: 'Gabinet 2',
        startsAt: '2026-10-05T08:00:00.000Z',
        endsAt: '2026-10-05T09:00:00.000Z',
        timeZone: 'Europe/Warsaw',
        status: 'planned',
        confirmedAt: null,
        isSettled: false,
        conflictOverrideAt: '2026-10-05T07:55:00.000Z',
        conflictOverrideCodes: ['member_double_booked'],
        updatedAt: '2026-10-05T07:55:00.000Z',
      }],
      lanes: [{
        subjectType: 'member',
        subjectId: id(3),
        subjectName: 'Anna Nowicka',
        hasSchedule: true,
        unknown: false,
        windows: [{
          id: 'member-lane',
          kind: 'exception',
          from: '2026-10-05T07:00:00.000Z',
          to: '2026-10-05T15:00:00.000Z',
        }],
      }],
      degraded: [{
        code: 'availability_unknown',
        subjectType: 'resource',
        subjectId: id(4),
        subjectName: 'Gabinet 2',
      }],
      range: {
        from: '2026-10-05T00:00:00.000Z',
        to: '2026-10-06T00:00:00.000Z',
      },
    })
    expect(result.items[0]).not.toHaveProperty('description')
    expect(result.items[0]).not.toHaveProperty('services')
    expect(result.lanes[0]?.windows[0]).not.toHaveProperty('reasonLabel')
  })

  it('uses trusted scope, half-open overlap, host ACLs, and non-enumerating filter resolution', () => {
    expect(routeSource).toContain("requireFeatures: ['patient.visits.view', 'patient.patients.view']")
    expect(routeSource).toContain('ctx.selectedOrganizationId ?? ctx.auth?.orgId')
    expect(routeSource).not.toContain('tenantId: parsed')
    expect(routeSource).not.toContain('organizationId: parsed')
    expect(routeSource).toContain('startsAt: { $lt: to }')
    expect(routeSource).toContain('{ endsAt: { $gt: from } }')
    expect(routeSource).toContain('{ endsAt: null, startsAt: { $gte: from } }')
    expect(routeSource).toContain("canViewHostReason(ctx, scope, 'staff.view')")
    expect(routeSource).toContain("canViewHostReason(ctx, scope, 'resources.view')")
    expect(routeSource).toContain('members.get(parsed.teamMemberId) ?? null')
    expect(routeSource).toContain('resources.get(parsed.resourceId) ?? null')
    expect(routeSource).not.toContain('requireActiveTeamMember')
    expect(routeSource).not.toContain('requireActiveResource')
    expect(routeSource).toContain('findWithDecryption(')
    expect(routeSource).toContain('readPatientCalendarStore(() => findWithDecryption(')
    expect(routeSource).toContain('limit: PATIENT_VISIT_CALENDAR_MAX_ITEMS + 1')
    expect(routeSource).toContain("code: 'visit_calendar_too_many_items'")
  })
})
