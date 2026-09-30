import { expect, test } from '@playwright/test'
import {
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import {
  createAvailabilityRuleFixture,
  deleteAvailabilityRuleIfExists,
} from '@open-mercato/core/helpers/integration/plannerFixtures'
import {
  createStaffTeamMemberFixture,
  deleteStaffEntityIfExists,
} from '@open-mercato/core/helpers/integration/staffFixtures'
import {
  callApi,
  callApiOk,
  cleanupPatient,
  cleanupVisit,
  createPatient,
  createVisit,
  login,
  unique,
  type CreatedPatient,
  type ScopedActor,
} from './helpers/api'

type CalendarResponse = {
  items: Array<{
    id: string
    patientId: string
    teamMemberId: string
    resourceId: string | null
    status: string
    startsAt: string
    endsAt: string | null
    description?: unknown
    services?: unknown
  }>
  lanes: Array<{
    subjectType: 'member' | 'resource'
    subjectId: string
    hasSchedule: boolean
    unknown: boolean
    windows: Array<{ kind: 'availability' | 'exception'; from: string; to: string }>
  }>
  degraded: Array<{ code: string; subjectType: string; subjectId: string }>
  range: { from: string; to: string }
}

function actorScope(actor: ScopedActor): { tenantId: string; organizationId: string } {
  const encoded = actor.token.split('.')[1]
  if (!encoded) throw new Error('Authenticated fixture token has no JWT payload')
  const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
    tenantId?: unknown
    orgId?: unknown
  }
  if (typeof claims.tenantId !== 'string' || typeof claims.orgId !== 'string') {
    throw new Error('Authenticated fixture token has no tenant/organization scope')
  }
  return { tenantId: claims.tenantId, organizationId: claims.orgId }
}

function calendarPath(
  from: string,
  to: string,
  filters: Record<string, string> = {},
): string {
  const query = new URLSearchParams({ from, to, ...filters })
  return `/api/patient/visits/calendar?${query.toString()}`
}

test.describe('VCAL-T01: scoped visit calendar API', () => {
  test('returns half-open ranges, selected lanes and strict filters, and rejects a 63-day request', async ({ request }) => {
    const actor = await login(request)
    const scope = actorScope(actor)
    const patients: CreatedPatient[] = []
    const visitIds: string[] = []
    let teamMemberId: string | null = null
    let otherTeamMemberId: string | null = null
    let resourceId: string | null = null
    let ruleId: string | null = null
    let foreignOrganizationId: string | null = null
    try {
      const patient = await createPatient(request, actor, {
        firstName: 'Calendar',
        lastName: unique('VCAL range patient'),
      })
      const otherPatient = await createPatient(request, actor, {
        firstName: 'Calendar',
        lastName: unique('VCAL outside patient'),
      })
      patients.push(patient, otherPatient)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VCAL calendar clinician'),
      })
      otherTeamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VCAL other clinician'),
      })
      resourceId = (await callApiOk<{ id: string }>(
        request,
        'POST',
        '/api/resources/resources',
        actor,
        { name: unique('VCAL room'), isActive: true },
      )).id
      ruleId = await createAvailabilityRuleFixture(request, actor.token, {
        ...scope,
        subjectType: 'member',
        subjectId: teamMemberId,
        timezone: 'Europe/Warsaw',
        rrule: 'DTSTART:20990510T060000Z\nDURATION:PT8H\nRRULE:FREQ=WEEKLY;COUNT=8',
        kind: 'availability',
      })

      for (const input of [
        {
          patientId: patient.id,
          teamMemberId,
          resourceId,
          startsAt: '2099-05-10T10:00:00+02:00',
          endsAt: '2099-05-10T10:45:00+02:00',
          timeZone: 'Europe/Warsaw',
          description: 'This clinical note must never enter the calendar payload',
        },
        {
          patientId: otherPatient.id,
          teamMemberId: otherTeamMemberId,
          startsAt: '2099-05-11T11:00:00+02:00',
          endsAt: '2099-05-11T11:30:00+02:00',
          timeZone: 'Europe/Warsaw',
        },
        {
          patientId: otherPatient.id,
          teamMemberId: otherTeamMemberId,
          startsAt: '2099-05-20T12:00:00+02:00',
          endsAt: '2099-05-20T12:30:00+02:00',
          timeZone: 'Europe/Warsaw',
        },
      ]) {
        const created = await createVisit(request, actor, input)
        visitIds.push(created.id)
      }

      const from = '2099-05-10T00:00:00+02:00'
      const to = '2099-05-17T00:00:00+02:00'
      const calendar = await callApiOk<CalendarResponse>(
        request,
        'GET',
        calendarPath(from, to, { teamMemberId, resourceId, status: 'planned' }),
        actor,
      )
      expect(calendar.items.map((item) => item.id)).toEqual([visitIds[0]])
      expect(calendar.items[0]).toMatchObject({
        patientId: patient.id,
        teamMemberId,
        resourceId,
        status: 'planned',
      })
      expect(calendar.items[0]).not.toHaveProperty('description')
      expect(calendar.items[0]).not.toHaveProperty('services')
      expect(calendar.lanes).toEqual(expect.arrayContaining([
        expect.objectContaining({ subjectType: 'member', subjectId: teamMemberId, hasSchedule: true }),
        expect.objectContaining({ subjectType: 'resource', subjectId: resourceId }),
      ]))
      const memberLane = calendar.lanes.find((lane) => lane.subjectId === teamMemberId)
      expect(memberLane?.windows.some((window) => window.kind === 'availability')).toBe(true)
      expect(calendar.range).toEqual({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      })

      const patientOnly = await callApiOk<CalendarResponse>(
        request,
        'GET',
        calendarPath(from, to, { patientId: otherPatient.id }),
        actor,
      )
      expect(patientOnly.items.map((item) => item.id)).toEqual([visitIds[1]])

      const touchingRange = await callApiOk<CalendarResponse>(
        request,
        'GET',
        calendarPath('2099-05-10T10:45:00+02:00', '2099-05-10T11:45:00+02:00'),
        actor,
      )
      expect(touchingRange.items.map((item) => item.id)).not.toContain(visitIds[0])

      const tooWide = await callApi(
        request,
        'GET',
        calendarPath('2099-01-01T00:00:00Z', '2099-03-05T00:00:00Z'),
        actor,
      )
      expect(tooWide.status).toBe(400)

      const unknownSubject = await callApiOk<CalendarResponse>(
        request,
        'GET',
        calendarPath(from, to, { teamMemberId: '99999999-9999-4999-8999-999999999999' }),
        actor,
      )
      expect(unknownSubject).toMatchObject({ items: [], lanes: [], degraded: [] })

      foreignOrganizationId = await createOrganizationFixture(request, actor.token, {
        name: unique('VCAL foreign organization'),
        tenantId: scope.tenantId,
      })
      const foreignActor: ScopedActor = {
        token: actor.token,
        headers: {
          ...actor.headers,
          cookie: `om_selected_org=${foreignOrganizationId}`,
        },
      }
      const foreignCalendar = await callApiOk<CalendarResponse>(
        request,
        'GET',
        calendarPath(from, to),
        foreignActor,
      )
      expect(foreignCalendar).toMatchObject({ items: [], lanes: [], degraded: [] })

      const foreignAvailability = await callApi<{ error?: string }>(
        request,
        'GET',
        `/api/patient/visits/availability-check?${new URLSearchParams({
          teamMemberId,
          startsAt: '2099-05-10T10:00:00+02:00',
          endsAt: '2099-05-10T10:30:00+02:00',
        }).toString()}`,
        foreignActor,
      )
      expect(foreignAvailability.status).toBe(422)
      expect(foreignAvailability.body.error).toBe('Referenced team member is not active in this scope')
      expect(JSON.stringify(foreignAvailability.body)).not.toContain(teamMemberId)
    } finally {
      for (const visitId of visitIds.reverse()) await cleanupVisit(request, actor, visitId)
      for (const patient of patients.reverse()) await cleanupPatient(request, actor, patient.id)
      await deleteAvailabilityRuleIfExists(request, actor.token, ruleId)
      await callApi(
        request,
        'DELETE',
        '/api/resources/resources',
        actor,
        resourceId ? { id: resourceId } : undefined,
      )
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', otherTeamMemberId)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
      await deleteOrganizationIfExists(request, actor.token, foreignOrganizationId)
    }
  })
})
