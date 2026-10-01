import { expect, test } from '@playwright/test'
import { Client } from 'pg'
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
      const clinicianName = unique('VIS clinician')
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: clinicianName,
      })
      const consultationTitle = unique('VIS consultation')
      firstProductId = await createProductFixture(request, actor.token, {
        title: consultationTitle,
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
        description: 'Encrypted integration visit note',
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
      expect(populated?.services.every((service) => service.isAvailable)).toBe(true)

      // Runtime encryption proof, not a source declaration check: the owning APIs return
      // plaintext while the database stores ciphertext and the upgrade maps exist for the
      // exact scope used by the write.
      const databaseUrl = process.env.DATABASE_URL
      expect(databaseUrl, 'DATABASE_URL is required for the encryption integration proof').toBeTruthy()
      const db = new Client({ connectionString: databaseUrl })
      await db.connect()
      try {
        const visitRow = await db.query(
          'select tenant_id, organization_id, team_member_name_snapshot, description from patient_visits where id = $1',
          [visitId],
        ) as { rows: Array<{
          tenant_id: string
          organization_id: string
          team_member_name_snapshot: string
          description: string
        }> }
        const storedVisit = visitRow.rows[0]
        expect(storedVisit).toBeTruthy()
        expect(storedVisit.team_member_name_snapshot).not.toBe(clinicianName)
        expect(storedVisit.description).not.toBe('Encrypted integration visit note')
        expect(populated?.teamMemberName).toBe(clinicianName)

        const serviceRows = await db.query(
          'select product_title_snapshot from patient_visit_services where visit_id = $1 and deleted_at is null',
          [visitId],
        ) as { rows: Array<{ product_title_snapshot: string }> }
        expect(serviceRows.rows.some((row) => row.product_title_snapshot === consultationTitle)).toBe(false)
        expect(populated?.services.some((service) => service.title === consultationTitle)).toBe(true)

        const maps = await db.query(
          `select entity_id from encryption_maps
           where tenant_id = $1 and organization_id = $2 and deleted_at is null and is_active = true
             and entity_id = any($3::text[])`,
          [
            storedVisit.tenant_id,
            storedVisit.organization_id,
            [
              'patient:patient_list_projection',
              'patient:patient_visit',
              'patient:patient_visit_service',
            ],
          ],
        ) as { rows: Array<{ entity_id: string }> }
        expect(new Set(maps.rows.map((row) => row.entity_id))).toEqual(new Set([
          'patient:patient_list_projection',
          'patient:patient_visit',
          'patient:patient_visit_service',
        ]))
      } finally {
        await db.end()
      }

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
