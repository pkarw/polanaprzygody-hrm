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
        serviceProductIds: [secondProductId, firstProductId],
      })
      const populated = await readVisit(request, actor, visitId)
      expect(populated?.services.map((service) => service.productId))
        .toEqual([secondProductId, firstProductId])
      expect(populated?.services.map((service) => service.position)).toEqual([0, 1])
      expect(populated?.services.every((service) => service.title.length > 0)).toBe(true)

      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: populated?.updatedAt,
        serviceProductIds: [],
      })
      expect((await readVisit(request, actor, visitId))?.services).toEqual([])
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
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
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })
})
