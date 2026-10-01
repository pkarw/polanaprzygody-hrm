import { expect, test } from '@playwright/test'
import { Client } from 'pg'
import {
  createUserFixture,
  deleteUserIfExists,
  setUserAclVisibility,
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
  newRequestId,
  readVisit,
  unique,
  type CreatedPatient,
  type ScopedActor,
} from './helpers/api'

type Conflict = {
  code: string
  severity: 'warning' | 'blocking'
  signature: string
  reason?: string
}

type ConflictBody = {
  error?: string
  conflicts?: Conflict[]
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

async function readConflict(
  request: Parameters<typeof callApi>[0],
  actor: ScopedActor,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: ConflictBody }> {
  return await callApi<ConflictBody>(request, 'POST', '/api/patient/visits', actor, {
    ...payload,
    clientRequestId: payload.clientRequestId ?? newRequestId(),
  })
}

test.describe('VCAL-T02–T07: save-path availability and conflict decisions', () => {
  test('treats approved leave as blocking while pending/rejected leave remains non-blocking', async ({ request }) => {
    const actor = await login(request)
    const patients: CreatedPatient[] = []
    const visitIds: string[] = []
    const leaveIds: string[] = []
    let teamMemberId: string | null = null
    let limitedUserId: string | null = null
    try {
      const patient = await createPatient(request, actor)
      patients.push(patient)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VCAL leave clinician'),
      })
      for (const date of ['2099-05-12', '2099-05-13']) {
        const leave = await callApiOk<{ id: string }>(request, 'POST', '/api/staff/leave-requests', actor, {
          memberId: teamMemberId,
          timezone: 'Europe/Warsaw',
          startDate: `${date}T00:00:00+02:00`,
          endDate: `${date}T23:59:59+02:00`,
          unavailabilityReasonValue: 'Private leave reason must not leak',
        })
        leaveIds.push(leave.id)
      }

      const pendingVisit = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-05-12T10:00:00+02:00',
        endsAt: '2099-05-12T10:30:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      visitIds.push(pendingVisit.id)
      await callApiOk(request, 'POST', '/api/staff/leave-requests/reject', actor, { id: leaveIds[1] })
      const rejectedVisit = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-05-13T10:00:00+02:00',
        endsAt: '2099-05-13T10:30:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      visitIds.push(rejectedVisit.id)

      await callApiOk(request, 'POST', '/api/staff/leave-requests/accept', actor, { id: leaveIds[0] })
      const blocked = await readConflict(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-05-12T11:00:00+02:00',
        endsAt: '2099-05-12T11:30:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      expect(blocked.status).toBe(422)
      expect(blocked.body.error).toBe('visit_conflict_blocking')
      const absence = blocked.body.conflicts?.find((conflict) => conflict.code === 'member_absence')
      expect(absence).toMatchObject({ severity: 'blocking' })

      const stillBlockedWithOverride = await readConflict(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-05-12T11:00:00+02:00',
        endsAt: '2099-05-12T11:30:00+02:00',
        timeZone: 'Europe/Warsaw',
        conflictOverride: {
          acknowledgedSignatures: absence ? [absence.signature] : [],
          reason: 'A blocking absence can never be overridden',
        },
      })
      expect(stillBlockedWithOverride.status).toBe(422)
      expect(stillBlockedWithOverride.body.error).toBe('visit_conflict_blocking')

      const email = `${unique('vcal-no-staff-view')}@example.test`
      const password = 'Visit-Test-42!'
      limitedUserId = await createUserFixture(request, actor.token, {
        email,
        password,
        name: 'VCAL actor without staff visibility',
        organizationId: actorScope(actor).organizationId,
        roles: [],
      })
      await setUserAclVisibility(request, actor.token, {
        userId: limitedUserId,
        organizations: [actorScope(actor).organizationId],
        features: ['patient.patients.view', 'patient.visits.view', 'patient.visits.manage'],
      })
      const limitedActor = await login(request, { email, password })
      const publicCheck = await callApi<{ conflicts?: Conflict[] }>(
        request,
        'GET',
        `/api/patient/visits/availability-check?${new URLSearchParams({
          teamMemberId,
          startsAt: '2099-05-12T11:00:00+02:00',
          endsAt: '2099-05-12T11:30:00+02:00',
        }).toString()}`,
        limitedActor,
      )
      expect(publicCheck.status, JSON.stringify(publicCheck.body)).toBe(200)
      expect(publicCheck.body.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'member_unavailable', severity: 'blocking' }),
      ]))
      expect(JSON.stringify(publicCheck.body)).not.toContain('Private leave reason must not leak')
    } finally {
      for (const visitId of visitIds.reverse()) await cleanupVisit(request, actor, visitId)
      for (const leaveId of leaveIds.reverse()) {
        await callApi(request, 'DELETE', '/api/staff/leave-requests', actor, { id: leaveId })
      }
      for (const patient of patients.reverse()) await cleanupPatient(request, actor, patient.id)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
      await deleteUserIfExists(request, actor.token, limitedUserId)
    }
  })

  test('requires exact warning signatures, allows end-touching visits, and blocks inactive resources', async ({ request }) => {
    const actor = await login(request)
    const scope = actorScope(actor)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let resourceId: string | null = null
    let inactiveResourceId: string | null = null
    let resourceRuleId: string | null = null
    const visitIds: string[] = []
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VCAL conflict clinician'),
      })
      resourceId = (await callApiOk<{ id: string }>(request, 'POST', '/api/resources/resources', actor, {
        name: unique('VCAL warning room'),
        isActive: true,
      })).id
      inactiveResourceId = (await callApiOk<{ id: string }>(request, 'POST', '/api/resources/resources', actor, {
        name: unique('VCAL inactive room'),
        isActive: false,
      })).id
      resourceRuleId = await createAvailabilityRuleFixture(request, actor.token, {
        ...scope,
        subjectType: 'resource',
        subjectId: resourceId,
        timezone: 'Europe/Warsaw',
        rrule: 'DTSTART:20990514T080000Z\nDURATION:PT4H\nRRULE:FREQ=DAILY;COUNT=1',
        kind: 'unavailability',
        unavailabilityReasonValue: 'Internal room maintenance',
      })

      const base = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-05-14T10:00:00+02:00',
        endsAt: '2099-05-14T11:00:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      visitIds.push(base.id)
      const touching = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-05-14T11:00:00+02:00',
        endsAt: '2099-05-14T11:30:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      visitIds.push(touching.id)

      const warning = await readConflict(request, actor, {
        patientId: patient.id,
        teamMemberId,
        resourceId,
        startsAt: '2099-05-14T10:30:00+02:00',
        endsAt: '2099-05-14T10:45:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      expect(warning.status).toBe(422)
      expect(warning.body.error).toBe('visit_conflict_unacknowledged')
      expect(warning.body.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'member_double_booked', severity: 'warning' }),
        expect.objectContaining({ code: 'resource_unavailable', severity: 'warning' }),
      ]))
      const signatures = warning.body.conflicts
        ?.filter((conflict) => conflict.severity === 'warning')
        .map((conflict) => conflict.signature) ?? []
      const overrideReason = unique('Clinical scheduling decision')

      const incomplete = await readConflict(request, actor, {
        patientId: patient.id,
        teamMemberId,
        resourceId,
        startsAt: '2099-05-14T10:30:00+02:00',
        endsAt: '2099-05-14T10:45:00+02:00',
        timeZone: 'Europe/Warsaw',
        conflictOverride: { acknowledgedSignatures: signatures.slice(0, 1), reason: 'Incomplete' },
      })
      expect(incomplete).toMatchObject({ status: 422, body: { error: 'visit_conflict_unacknowledged' } })

      const overridden = await callApiOk<{ id: string; updatedAt: string }>(request, 'POST', '/api/patient/visits', actor, {
        patientId: patient.id,
        teamMemberId,
        resourceId,
        startsAt: '2099-05-14T10:30:00+02:00',
        endsAt: '2099-05-14T10:45:00+02:00',
        timeZone: 'Europe/Warsaw',
        clientRequestId: newRequestId(),
        conflictOverride: { acknowledgedSignatures: signatures, reason: overrideReason },
      })
      visitIds.push(overridden.id)

      const databaseUrl = process.env.DATABASE_URL
      expect(databaseUrl, 'DATABASE_URL is required for the override encryption proof').toBeTruthy()
      const db = new Client({ connectionString: databaseUrl })
      await db.connect()
      try {
        const stored = await db.query(
          `select tenant_id, organization_id, conflict_override_reason
             from patient_visits
            where id = $1`,
          [overridden.id],
        ) as { rows: Array<{
          tenant_id: string
          organization_id: string
          conflict_override_reason: string
        }> }
        expect(stored.rows).toHaveLength(1)
        expect(stored.rows[0]?.conflict_override_reason).not.toBe(overrideReason)
        expect(stored.rows[0]?.conflict_override_reason).not.toContain(overrideReason)

        const maps = await db.query(
          `select fields_json
             from encryption_maps
            where tenant_id = $1 and organization_id = $2
              and entity_id = 'patient:patient_visit'
              and deleted_at is null and is_active = true`,
          [stored.rows[0]?.tenant_id, stored.rows[0]?.organization_id],
        ) as { rows: Array<{ fields_json: Array<{ field?: string }> }> }
        expect(maps.rows).toHaveLength(1)
        expect(maps.rows[0]?.fields_json).toEqual(expect.arrayContaining([
          expect.objectContaining({ field: 'conflict_override_reason' }),
        ]))
      } finally {
        await db.end()
      }

      const inactive = await readConflict(request, actor, {
        patientId: patient.id,
        teamMemberId,
        resourceId: inactiveResourceId,
        startsAt: '2099-05-15T10:00:00+02:00',
        endsAt: '2099-05-15T10:30:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      expect(inactive.status).toBe(422)
      expect(inactive.body).toMatchObject({ error: 'visit_conflict_blocking' })
      expect(inactive.body.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'resource_inactive', severity: 'blocking' }),
      ]))

      const beforeCleanMove = await readVisit(request, actor, overridden.id)
      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: overridden.id,
        expectedUpdatedAt: beforeCleanMove?.updatedAt,
        resourceId: null,
        startsAt: '2099-05-16T10:00:00+02:00',
        endsAt: '2099-05-16T10:30:00+02:00',
      })
      const cleanCalendar = await callApiOk<{ items: Array<{ id: string; conflictOverrideAt: string | null }> }>(
        request,
        'GET',
        `/api/patient/visits/calendar?${new URLSearchParams({
          from: '2099-05-16T00:00:00+02:00',
          to: '2099-05-17T00:00:00+02:00',
        }).toString()}`,
        actor,
      )
      expect(cleanCalendar.items.find((item) => item.id === overridden.id)?.conflictOverrideAt).toBeNull()
    } finally {
      for (const visitId of visitIds.reverse()) await cleanupVisit(request, actor, visitId)
      await deleteAvailabilityRuleIfExists(request, actor.token, resourceRuleId)
      for (const id of [inactiveResourceId, resourceId]) {
        await callApi(request, 'DELETE', '/api/resources/resources', actor, id ? { id } : undefined)
      }
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })
})

test.describe('VCAL-T09–T10: degraded schedules and serialized writes', () => {
  test('keeps no-schedule subjects explicit and serializes concurrent bookings and retries', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    const visitIds: string[] = []
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VCAL concurrent clinician'),
      })
      const calendar = await callApiOk<{
        lanes: Array<{ subjectId: string; hasSchedule: boolean; unknown: boolean }>
      }>(request, 'GET', `/api/patient/visits/calendar?${new URLSearchParams({
        from: '2099-05-18T00:00:00+02:00',
        to: '2099-05-19T00:00:00+02:00',
        teamMemberId,
      }).toString()}`, actor)
      expect(calendar.lanes).toEqual([
        expect.objectContaining({ subjectId: teamMemberId, hasSchedule: false, unknown: false }),
      ])

      const sharedRequestId = newRequestId()
      const retryInput = {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-05-18T10:00:00+02:00',
        endsAt: '2099-05-18T10:30:00+02:00',
        timeZone: 'Europe/Warsaw',
        clientRequestId: sharedRequestId,
      }
      const [firstRetry, secondRetry] = await Promise.all([
        callApi<{ id: string }>(request, 'POST', '/api/patient/visits', actor, retryInput),
        callApi<{ id: string }>(request, 'POST', '/api/patient/visits', actor, retryInput),
      ])
      expect(
        [firstRetry.status, secondRetry.status].every((status) => status >= 200 && status < 300),
        JSON.stringify([firstRetry, secondRetry]),
      ).toBe(true)
      expect(firstRetry.body.id).toBe(secondRetry.body.id)
      visitIds.push(firstRetry.body.id)

      const databaseUrl = process.env.DATABASE_URL
      expect(databaseUrl, 'DATABASE_URL is required for the idempotency row proof').toBeTruthy()
      const scope = actorScope(actor)
      const db = new Client({ connectionString: databaseUrl })
      await db.connect()
      try {
        const rows = await db.query(
          `select id
             from patient_visits
            where tenant_id = $1 and organization_id = $2
              and client_request_id = $3 and deleted_at is null`,
          [scope.tenantId, scope.organizationId, sharedRequestId],
        ) as { rows: Array<{ id: string }> }
        expect(rows.rows).toEqual([{ id: firstRetry.body.id }])
      } finally {
        await db.end()
      }

      const makeConcurrent = (clientRequestId: string) => callApi<ConflictBody>(
        request,
        'POST',
        '/api/patient/visits',
        actor,
        {
          patientId: patient?.id,
          teamMemberId,
          startsAt: '2099-05-18T11:00:00+02:00',
          endsAt: '2099-05-18T11:30:00+02:00',
          timeZone: 'Europe/Warsaw',
          clientRequestId,
        },
      )
      const race = await Promise.all([makeConcurrent(newRequestId()), makeConcurrent(newRequestId())])
      expect(race.filter((result) => result.status >= 200 && result.status < 300)).toHaveLength(1)
      expect(race.filter((result) => result.status === 422)).toHaveLength(1)
      const winner = race.find((result) => result.status >= 200 && result.status < 300)
      if (winner && typeof (winner.body as { id?: unknown }).id === 'string') {
        visitIds.push((winner.body as { id: string }).id)
      }
      const loser = race.find((result) => result.status === 422)
      expect(loser?.body).toMatchObject({ error: 'visit_conflict_unacknowledged' })
      expect(loser?.body.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'member_double_booked' }),
      ]))
    } finally {
      for (const visitId of visitIds.reverse()) await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })

  test('fails closed without authentication', async ({ request }) => {
    const response = await callApi(
      request,
      'GET',
      `/api/patient/visits/calendar?${new URLSearchParams({
        from: '2099-05-18T00:00:00Z',
        to: '2099-05-19T00:00:00Z',
      }).toString()}`,
      null,
    )
    expect(response.status).toBe(401)
  })
})
