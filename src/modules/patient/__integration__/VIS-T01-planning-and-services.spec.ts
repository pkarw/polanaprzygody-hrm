import { expect, test } from '@playwright/test'
import {
  createProductFixture,
  deleteCatalogProductIfExists,
} from '@open-mercato/core/helpers/integration/catalogFixtures'
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
} from './helpers/api'

test.describe('VIS-T01: visit planning and service list', () => {
  test('creates, edits, orders, clears, and re-reads service snapshots', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let firstProductId: string | null = null
    let secondProductId: string | null = null
    let thirdProductId: string | null = null
    let visitId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS clinician'),
      })
      firstProductId = await createProductFixture(request, actor.token, {
        title: unique('VIS consultation'),
        sku: unique('VIS-A'),
      })
      secondProductId = await createProductFixture(request, actor.token, {
        title: unique('VIS therapy'),
        sku: unique('VIS-B'),
      })
      thirdProductId = await createProductFixture(request, actor.token, {
        title: unique('VIS follow-up'),
        sku: unique('VIS-C'),
      })

      const created = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2026-11-05T10:00:00+01:00',
        endsAt: '2026-11-05T10:45:00+01:00',
        timeZone: 'Europe/Warsaw',
        resourceId: null,
        serviceProductIds: [],
      })
      visitId = created.id
      const empty = await readVisit(request, actor, visitId)
      expect(empty).toMatchObject({
        patientId: patient.id,
        teamMemberId,
        status: 'planned',
        resourceId: null,
        isConfirmed: false,
        isSettled: false,
        services: [],
      })

      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: empty?.updatedAt,
        serviceProductIds: [firstProductId],
      })
      const single = await readVisit(request, actor, visitId)
      expect(single?.services.map((service) => service.productId)).toEqual([firstProductId])

      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: single?.updatedAt,
        serviceProductIds: [thirdProductId, secondProductId, firstProductId],
      })
      const populated = await readVisit(request, actor, visitId)
      expect(populated?.services.map((service) => service.productId))
        .toEqual([thirdProductId, secondProductId, firstProductId])
      expect(populated?.services.map((service) => service.position)).toEqual([0, 1, 2])
      expect(populated?.services.every((service) => service.title.length > 0)).toBe(true)

      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: populated?.updatedAt,
        serviceProductIds: [],
      })
      const cleared = await readVisit(request, actor, visitId)
      expect(cleared?.services).toEqual([])

      await callApiOk(request, 'DELETE', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: cleared?.updatedAt,
      })
      expect(await readVisit(request, actor, visitId)).toBeNull()
      visitId = null
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteCatalogProductIfExists(request, actor.token, thirdProductId)
      await deleteCatalogProductIfExists(request, actor.token, secondProductId)
      await deleteCatalogProductIfExists(request, actor.token, firstProductId)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })

  test('returns the same visit for an identical idempotent create retry', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let visitId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS retry clinician'),
      })
      const input = {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2026-11-06T09:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        serviceProductIds: [],
        clientRequestId: newRequestId(),
      }
      const first = await createVisit(request, actor, input)
      visitId = first.id
      expect((await createVisit(request, actor, input)).id).toBe(first.id)

      const mismatch = await callApi(request, 'POST', '/api/patient/visits', actor, {
        ...input,
        startsAt: '2026-11-06T10:00:00+01:00',
      })
      expect(mismatch.status).toBe(409)
      expect((await readVisit(request, actor, visitId))?.startsAt).toBeTruthy()
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })

  test('requires a staff team-member reference on create', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    try {
      patient = await createPatient(request, actor)
      const result = await callApi(request, 'POST', '/api/patient/visits', actor, {
        patientId: patient.id,
        startsAt: '2026-11-05T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        clientRequestId: newRequestId(),
      })
      expect(result.status).toBe(400)
    } finally {
      await cleanupPatient(request, actor, patient?.id ?? null)
    }
  })
})
