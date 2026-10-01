import { expect, test } from '@playwright/test'
import {
  createStaffTeamMemberFixture,
  deleteStaffEntityIfExists,
} from '@open-mercato/core/helpers/integration/staffFixtures'
import {
  buildPatientInput,
  callApi,
  callApiOk,
  cleanupPatient,
  cleanupVisit,
  createPatient,
  createVisit,
  listAddresses,
  login,
  newRequestId,
  readPatient,
  requirePatient,
  unique,
  type CreatedPatient,
} from './helpers/api'

/**
 * PAT-T01 — the record's own lifecycle.
 *
 * Oracle (spec): atomicity of create, a contact channel, a server-assigned number, working
 * versions, archive/restore, deletion of an empty card, and no hidden CRM person.
 */
test.describe('PAT-T01: patient record lifecycle', () => {
  test('creates a record with its first address atomically and assigns a server-side number', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor, { firstName: 'Anna', lastName: 'Atomowa' })

      const record = await requirePatient(request, actor, created.id)
      expect(record.firstName).toBe('Anna')
      expect(record.status).toBe('active')
      // Server-assigned from a distinct UUID, never the primary key or a national identifier.
      expect(record.patientNumber).toMatch(
        /^P-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      expect(record.patientNumber).not.toBe(`P-${created.id}`)
      // The version token must be projected, or optimistic locking is silently off.
      expect(record.updatedAt).toBeTruthy()

      // Atomicity: the address exists in the same breath as the record, and is primary because
      // an active record always has exactly one.
      const addresses = await listAddresses(request, actor, created.id)
      expect(addresses).toHaveLength(1)
      expect(addresses[0].isPrimary).toBe(true)

      // No CRM person was created behind the operator's back.
      expect(record.owner).toBeNull()
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses a record with no contact channel of its own', async ({ request }) => {
    const actor = await login(request)
    const input = buildPatientInput()
    delete (input as Record<string, unknown>).email

    const result = await callApi(request, 'POST', '/api/patient/patients', actor, input)
    // A patient must have their own channel; a guardian's is not fetched in its place.
    expect(result.status).toBe(400)
  })

  test('refuses a first address without a city or a country', async ({ request }) => {
    const actor = await login(request)
    const noCity = await callApi(
      request,
      'POST',
      '/api/patient/patients',
      actor,
      buildPatientInput({ primaryAddress: { addressLine1: 'Testowa 1', country: 'PL' } }),
    )
    expect(noCity.status).toBe(400)

    const noCountry = await callApi(
      request,
      'POST',
      '/api/patient/patients',
      actor,
      buildPatientInput({ primaryAddress: { addressLine1: 'Testowa 1', city: 'Wrocław' } }),
    )
    expect(noCountry.status).toBe(400)
  })

  test('round-trips an edit, clears a nullable field, and keeps the version moving', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor, { description: 'Pierwsza notatka' })
      const before = await requirePatient(request, actor, created.id)
      expect(before.description).toBe('Pierwsza notatka')

      await callApiOk(request, 'PUT', '/api/patient/patients', actor, {
        id: created.id,
        expectedUpdatedAt: before.updatedAt,
        // Explicit null clears; the read-back is what proves no truthy fallback resurrects it.
        description: null,
        firstName: 'Zmieniona',
      })

      const after = await requirePatient(request, actor, created.id)
      expect(after.description).toBeNull()
      expect(after.firstName).toBe('Zmieniona')
      expect(new Date(String(after.updatedAt)).getTime()).toBeGreaterThan(
        new Date(String(before.updatedAt)).getTime(),
      )
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('archives and restores through the dedicated endpoint, and rejects status on the generic update', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const initial = await requirePatient(request, actor, created.id)

      // The generic update must REFUSE a server-owned field rather than ignore it: a 200 here
      // would tell the client the record was archived when it was not.
      const smuggled = await callApi(request, 'PUT', '/api/patient/patients', actor, {
        id: created.id,
        expectedUpdatedAt: initial.updatedAt,
        status: 'archived',
      })
      expect(smuggled.status).toBe(400)
      expect((await requirePatient(request, actor, created.id)).status).toBe('active')

      const archived = await callApiOk<{ status: string }>(
        request,
        'POST',
        `/api/patient/patients/${encodeURIComponent(created.id)}/archive`,
        actor,
        { archived: true, expectedUpdatedAt: initial.updatedAt },
      )
      expect(archived.status).toBe('archived')

      const afterArchive = await requirePatient(request, actor, created.id)
      expect(afterArchive.status).toBe('archived')
      // Status and its timestamp are one fact in two columns and must agree.
      expect(afterArchive.archivedAt).toBeTruthy()

      // Archiving blocks NEW entries while keeping the record readable.
      const blocked = await callApi(request, 'POST', '/api/patient/addresses', actor, {
        patientId: created.id,
        addressLine1: 'Nowa 2',
        city: 'Wrocław',
        country: 'PL',
      })
      expect(blocked.status).toBe(409)

      const restored = await callApiOk<{ status: string }>(
        request,
        'POST',
        `/api/patient/patients/${encodeURIComponent(created.id)}/archive`,
        actor,
        { archived: false, expectedUpdatedAt: afterArchive.updatedAt },
      )
      expect(restored.status).toBe('active')
      expect((await requirePatient(request, actor, created.id)).archivedAt).toBeNull()
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('soft-deletes an empty record and stops reading it', async ({ request }) => {
    const actor = await login(request)
    const created = await createPatient(request, actor)
    const record = await requirePatient(request, actor, created.id)

    await callApiOk(request, 'DELETE', '/api/patient/patients', actor, {
      id: created.id,
      expectedUpdatedAt: record.updatedAt,
    })

    // Soft-deleted: gone from the read path, with the row retained for history.
    expect(await readPatient(request, actor, created.id)).toBeNull()
  })

  test('returns the same record for a repeated create and 409 for a reused key with different content', async ({ request }) => {
    const actor = await login(request)
    const clientRequestId = newRequestId()
    const input = buildPatientInput({ clientRequestId, lastName: 'Idempotentny' })
    let createdId: string | null = null
    try {
      const first = await callApiOk<CreatedPatient>(request, 'POST', '/api/patient/patients', actor, input)
      createdId = first.id

      // The same key with the same content is a retry, not a second patient.
      const retry = await callApiOk<CreatedPatient>(request, 'POST', '/api/patient/patients', actor, input)
      expect(retry.id).toBe(first.id)

      // The same key with DIFFERENT content is a client error, not a silent no-op: returning the
      // old record would hide that the second request never took effect.
      const conflicting = await callApi(request, 'POST', '/api/patient/patients', actor, {
        ...input,
        lastName: 'Inny',
      })
      expect(conflicting.status).toBe(409)
    } finally {
      await cleanupPatient(request, actor, createdId)
    }
  })

  test('refuses archiving while a planned visit exists', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let visitId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('PAT visit archive invariant'),
      })
      const created = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2026-11-11T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
      })
      visitId = created.id
      const record = await requirePatient(request, actor, patient.id)

      const blocked = await callApi(
        request,
        'POST',
        `/api/patient/patients/${patient.id}/archive`,
        actor,
        { archived: true, expectedUpdatedAt: record.updatedAt },
      )
      expect(blocked.status).toBe(409)
      expect(blocked.body).toMatchObject({ code: 'patient_has_planned_visits' })
      expect((await requirePatient(request, actor, patient.id)).status).toBe('active')
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })
})
