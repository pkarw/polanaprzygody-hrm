import { expect, test } from '@playwright/test'
import {
  createUserFixture,
  deleteUserIfExists,
  setUserAclVisibility,
} from '@open-mercato/core/helpers/integration/authFixtures'
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
  readVisit,
  unique,
  visitAction,
  type CreatedPatient,
  type ScopedActor,
} from './helpers/api'

function readActorScope(actor: ScopedActor): { tenantId: string; organizationId: string } {
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

test.describe('VIS-T04: visit lifecycle actions', () => {
  test('confirms, resets confirmation on schedule edits, closes, and explicitly reopens', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let replacementTeamMemberId: string | null = null
    let resourceId: string | null = null
    let visitId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS lifecycle clinician'),
      })
      replacementTeamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS replacement clinician'),
      })
      const resource = await callApiOk<{ id: string }>(
        request,
        'POST',
        '/api/resources/resources',
        actor,
        { name: unique('VIS room'), isActive: true },
      )
      resourceId = resource.id
      const created = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2020-01-15T10:00:00+01:00',
        endsAt: '2020-01-15T10:45:00+01:00',
        timeZone: 'Europe/Warsaw',
      })
      visitId = created.id

      const confirmed = await visitAction(request, actor, visitId, 'confirmation', {
        confirmed: true,
        expectedUpdatedAt: created.updatedAt,
      })
      expect(confirmed).toMatchObject({
        status: 'planned',
        isConfirmed: true,
        confirmationApplicable: true,
      })
      expect(confirmed.confirmedAt).toBeTruthy()

      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: confirmed.updatedAt,
        startsAt: '2020-01-15T11:00:00+01:00',
        endsAt: '2020-01-15T11:45:00+01:00',
      })
      const rescheduled = await readVisit(request, actor, visitId)
      expect(rescheduled).toMatchObject({ isConfirmed: false, confirmedAt: null })

      const scheduleReconfirmed = await visitAction(request, actor, visitId, 'confirmation', {
        confirmed: true,
        expectedUpdatedAt: rescheduled?.updatedAt,
      })
      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: scheduleReconfirmed.updatedAt,
        teamMemberId: replacementTeamMemberId,
      })
      const reassigned = await readVisit(request, actor, visitId)
      expect(reassigned).toMatchObject({
        teamMemberId: replacementTeamMemberId,
        isConfirmed: false,
        confirmedAt: null,
      })

      const staffReconfirmed = await visitAction(request, actor, visitId, 'confirmation', {
        confirmed: true,
        expectedUpdatedAt: reassigned?.updatedAt,
      })
      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: staffReconfirmed.updatedAt,
        resourceId,
      })
      const relocated = await readVisit(request, actor, visitId)
      expect(relocated).toMatchObject({ resourceId, isConfirmed: false, confirmedAt: null })

      const reconfirmed = await visitAction(request, actor, visitId, 'confirmation', {
        confirmed: true,
        expectedUpdatedAt: relocated?.updatedAt,
      })
      const completed = await visitAction(request, actor, visitId, 'status', {
        status: 'completed',
        expectedUpdatedAt: reconfirmed.updatedAt,
      })
      expect(completed).toMatchObject({
        status: 'completed',
        isConfirmed: true,
        confirmationApplicable: false,
      })

      const closedConfirmation = await callApi(
        request,
        'POST',
        `/api/patient/visits/${visitId}/confirmation`,
        actor,
        { confirmed: false, expectedUpdatedAt: completed.updatedAt },
      )
      expect(closedConfirmation.status).toBe(409)

      const reopened = await visitAction(request, actor, visitId, 'status', {
        status: 'planned',
        reason: 'Correction after completion',
        expectedUpdatedAt: completed.updatedAt,
      })
      expect(reopened).toMatchObject({
        status: 'planned',
        isConfirmed: false,
        confirmedAt: null,
        confirmationApplicable: true,
      })

      for (const status of ['cancelled', 'no_show'] as const) {
        const closed = await visitAction(request, actor, visitId, 'status', {
          status,
          reason: `Test ${status}`,
          expectedUpdatedAt: (await readVisit(request, actor, visitId))?.updatedAt,
        })
        expect(closed.status).toBe(status)
        const opened = await visitAction(request, actor, visitId, 'status', {
          status: 'planned',
          reason: `Correct ${status}`,
          expectedUpdatedAt: closed.updatedAt,
        })
        expect(opened.status).toBe('planned')
      }

      const current = await readVisit(request, actor, visitId)
      const stale = await callApi(
        request,
        'POST',
        `/api/patient/visits/${visitId}/confirmation`,
        actor,
        { confirmed: true, expectedUpdatedAt: created.updatedAt },
      )
      expect(stale.status).toBe(409)
      expect(await readVisit(request, actor, visitId)).toMatchObject({
        updatedAt: current?.updatedAt,
        isConfirmed: false,
      })
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await callApi(request, 'DELETE', '/api/resources/resources', actor, resourceId ? { id: resourceId } : undefined)
      await deleteStaffEntityIfExists(
        request,
        actor.token,
        '/api/staff/team-members',
        replacementTeamMemberId,
      )
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })

  test('enforces reasons, future-time gates, explicit unconfirm, and no automatic status changes', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    const visitIds: string[] = []
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS lifecycle matrix clinician'),
      })
      const historical = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2020-03-15T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
      })
      visitIds.push(historical.id)
      expect(await readVisit(request, actor, historical.id)).toMatchObject({ status: 'planned' })

      const confirmed = await visitAction(request, actor, historical.id, 'confirmation', {
        confirmed: true,
        expectedUpdatedAt: historical.updatedAt,
      })
      const unconfirmed = await visitAction(request, actor, historical.id, 'confirmation', {
        confirmed: false,
        expectedUpdatedAt: confirmed.updatedAt,
      })
      expect(unconfirmed).toMatchObject({ status: 'planned', isConfirmed: false })

      for (const status of ['cancelled', 'no_show', 'planned'] as const) {
        const refused = await callApi(
          request,
          'POST',
          `/api/patient/visits/${historical.id}/status`,
          actor,
          { status, expectedUpdatedAt: unconfirmed.updatedAt },
        )
        expect(refused.status).toBe(400)
      }
      const noOp = await callApi(
        request,
        'POST',
        `/api/patient/visits/${historical.id}/status`,
        actor,
        { status: 'planned', reason: 'No-op is forbidden', expectedUpdatedAt: unconfirmed.updatedAt },
      )
      expect(noOp.status).toBe(409)

      const cancelled = await visitAction(request, actor, historical.id, 'status', {
        status: 'cancelled',
        reason: 'Matrix cancellation',
        expectedUpdatedAt: unconfirmed.updatedAt,
      })
      const closedToClosed = await callApi(
        request,
        'POST',
        `/api/patient/visits/${historical.id}/status`,
        actor,
        { status: 'completed', expectedUpdatedAt: cancelled.updatedAt },
      )
      expect(closedToClosed.status).toBe(409)
      await visitAction(request, actor, historical.id, 'status', {
        status: 'planned',
        reason: 'Restore after matrix proof',
        expectedUpdatedAt: cancelled.updatedAt,
      })

      const future = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-03-15T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
      })
      visitIds.push(future.id)
      for (const [status, reason] of [
        ['completed', undefined],
        ['no_show', 'Patient did not arrive'],
      ] as const) {
        const refused = await callApi(
          request,
          'POST',
          `/api/patient/visits/${future.id}/status`,
          actor,
          {
            status,
            ...(reason ? { reason } : {}),
            expectedUpdatedAt: future.updatedAt,
          },
        )
        expect(refused.status).toBe(422)
      }
      expect(await readVisit(request, actor, future.id)).toMatchObject({ status: 'planned' })
    } finally {
      for (const id of visitIds) await cleanupVisit(request, actor, id)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })
})

test.describe('VIS-T05: manual visit settlement', () => {
  test('keeps settlement behind its action route and independent of visit status', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let visitId: string | null = null
    let limitedUserId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS settlement clinician'),
      })
      const created = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2020-02-15T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
      })
      visitId = created.id

      const { organizationId } = readActorScope(actor)
      const limitedEmail = `${unique('vis-limited')}@example.test`
      const limitedPassword = 'Visit-Test-42!'
      limitedUserId = await createUserFixture(request, actor.token, {
        email: limitedEmail,
        name: 'VIS limited settlement actor',
        password: limitedPassword,
        organizationId,
        roles: [],
      })
      await setUserAclVisibility(request, actor.token, {
        userId: limitedUserId,
        organizations: [organizationId],
        features: ['patient.patients.view', 'patient.visits.view', 'patient.visits.manage'],
      })
      const actorWithoutSettlement = await login(request, {
        email: limitedEmail,
        password: limitedPassword,
      })

      const genericWrite = await callApi(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: created.updatedAt,
        isSettled: true,
      })
      expect(genericWrite.status).toBe(400)

      const forbiddenSettlement = await callApi(
        request,
        'POST',
        `/api/patient/visits/${visitId}/settlement`,
        actorWithoutSettlement,
        { isSettled: true, expectedUpdatedAt: created.updatedAt },
      )
      expect(forbiddenSettlement.status).toBe(403)
      expect(await readVisit(request, actor, visitId)).toMatchObject({
        isSettled: false,
        updatedAt: created.updatedAt,
      })

      const settled = await visitAction(request, actor, visitId, 'settlement', {
        isSettled: true,
        expectedUpdatedAt: created.updatedAt,
      })
      expect(settled).toMatchObject({ status: 'planned', isSettled: true })
      expect(settled.settledAt).toBeTruthy()

      const missingReason = await callApi(
        request,
        'POST',
        `/api/patient/visits/${visitId}/settlement`,
        actor,
        { isSettled: false, expectedUpdatedAt: settled.updatedAt },
      )
      expect(missingReason.status).toBe(400)
      expect(await readVisit(request, actor, visitId)).toMatchObject({
        isSettled: true,
        updatedAt: settled.updatedAt,
      })

      const unsettled = await visitAction(request, actor, visitId, 'settlement', {
        isSettled: false,
        reason: 'Settlement entered by mistake',
        expectedUpdatedAt: settled.updatedAt,
      })
      expect(unsettled).toMatchObject({ isSettled: false, settledAt: null })

      const cancelled = await visitAction(request, actor, visitId, 'status', {
        status: 'cancelled',
        reason: 'Patient cancelled',
        expectedUpdatedAt: unsettled.updatedAt,
      })
      const settledCancelled = await visitAction(request, actor, visitId, 'settlement', {
        isSettled: true,
        expectedUpdatedAt: cancelled.updatedAt,
      })
      expect(settledCancelled).toMatchObject({ status: 'cancelled', isSettled: true })
      const unsettledCancelled = await visitAction(request, actor, visitId, 'settlement', {
        isSettled: false,
        reason: 'Refunded deposit',
        expectedUpdatedAt: settledCancelled.updatedAt,
      })
      const reopened = await visitAction(request, actor, visitId, 'status', {
        status: 'planned',
        reason: 'Reopen after refund',
        expectedUpdatedAt: unsettledCancelled.updatedAt,
      })
      expect(reopened).toMatchObject({ status: 'planned', isSettled: false })

      const unauthenticated = await callApi(
        request,
        'POST',
        `/api/patient/visits/${visitId}/settlement`,
        null,
        { isSettled: true, expectedUpdatedAt: reopened.updatedAt },
      )
      expect(unauthenticated.status).toBe(401)
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
      await deleteUserIfExists(request, actor.token, limitedUserId)
    }
  })
})
