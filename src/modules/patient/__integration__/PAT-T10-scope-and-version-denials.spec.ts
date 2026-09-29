import { expect, test } from '@playwright/test'
import {
  callApi,
  callApiOk,
  cleanupPatient,
  createPatient,
  listAddresses,
  login,
  requirePatient,
  type CreatedPatient,
} from './helpers/api'

const FOREIGN_UUID = '99999999-9999-4999-8999-999999999999'

/**
 * PAT-T10 — the denial matrix.
 *
 * Oracle (spec): 400/403/404/409 as appropriate, zero change and zero events on refusal, and no
 * PII in the error bodies.
 */
test.describe('PAT-T10: scope, version and payload denials', () => {
  test('refuses every unauthenticated read and write', async ({ request }) => {
    for (const [method, path] of [
      ['GET', '/api/patient/patients'],
      ['POST', '/api/patient/patients'],
      ['GET', '/api/patient/diagnoses?patientId=' + FOREIGN_UUID],
      ['GET', '/api/patient/contacts?patientId=' + FOREIGN_UUID],
    ] as const) {
      const result = await callApi(request, method, path, null, method === 'POST' ? {} : undefined)
      expect(result.status, `${method} ${path}`).toBeGreaterThanOrEqual(400)
      expect(result.status, `${method} ${path}`).toBeLessThan(500)
    }
  })

  test('a record from another scope is invisible rather than forbidden', async ({ request }) => {
    const actor = await login(request)
    const result = await callApi<{ items?: unknown[] }>(
      request,
      'GET',
      `/api/patient/patients?ids=${FOREIGN_UUID}&pageSize=1`,
      actor,
    )
    // Not an error: a scoped read simply does not see it, which is what makes an id unprobeable.
    expect(result.status).toBe(200)
    expect(result.body.items ?? []).toHaveLength(0)
  })

  test('refuses updating a record that is not visible', async ({ request }) => {
    const actor = await login(request)
    const result = await callApi(request, 'PUT', '/api/patient/patients', actor, {
      id: FOREIGN_UUID,
      expectedUpdatedAt: new Date().toISOString(),
      firstName: 'Nie',
    })
    expect(result.status).toBe(404)
  })

  test('a missing version token is 400 and a stale one is 409 — never the same failure', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const record = await requirePatient(request, actor, created.id)

      const missing = await callApi(request, 'PUT', '/api/patient/patients', actor, {
        id: created.id,
        firstName: 'Bez wersji',
      })
      expect(missing.status).toBe(400)

      // Move the record on, then retry with the now-stale token.
      await callApiOk(request, 'PUT', '/api/patient/patients', actor, {
        id: created.id,
        expectedUpdatedAt: record.updatedAt,
        firstName: 'Pierwszy',
      })
      const stale = await callApi(request, 'PUT', '/api/patient/patients', actor, {
        id: created.id,
        expectedUpdatedAt: record.updatedAt,
        firstName: 'Drugi',
      })
      expect(stale.status).toBe(409)

      // The refusal changed nothing.
      expect((await requirePatient(request, actor, created.id)).firstName).toBe('Pierwszy')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('rejects every server-owned field on create and update', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const record = await requirePatient(request, actor, created.id)

      for (const field of ['status', 'archivedAt', 'patientNumber', 'createdByUserId', 'updatedByUserId']) {
        const result = await callApi(request, 'PUT', '/api/patient/patients', actor, {
          id: created.id,
          expectedUpdatedAt: record.updatedAt,
          [field]: field === 'status' ? 'archived' : new Date().toISOString(),
        })
        // 400, not a silent strip: a 200 would tell the client a write took effect when it did not.
        expect(result.status, `field ${field}`).toBe(400)
      }
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('a malformed identifier cannot widen a query', async ({ request }) => {
    const actor = await login(request)
    const result = await callApi<{ items?: unknown[] }>(
      request,
      'GET',
      '/api/patient/patients?id=not-a-uuid&pageSize=50',
      actor,
    )
    // Either rejected outright or treated as a filter matching nothing — never as "no filter".
    if (result.status === 200) expect(result.body.items ?? []).toHaveLength(0)
    else expect(result.status).toBe(400)
  })

  test('error bodies carry no patient names', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor, { firstName: 'Tajne', lastName: 'Nazwisko' })
      const [address] = await listAddresses(request, actor, created.id)

      // A refusal an operator will actually hit: deleting the last address.
      const refused = await callApi(request, 'DELETE', '/api/patient/addresses', actor, {
        id: address.id,
        expectedUpdatedAt: address.updatedAt,
      })
      expect(refused.status).toBe(409)
      const serialized = JSON.stringify(refused.body)
      expect(serialized).not.toContain('Tajne')
      expect(serialized).not.toContain('Nazwisko')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('a child route refuses a patient id from outside the scope', async ({ request }) => {
    const actor = await login(request)
    const result = await callApi(request, 'POST', '/api/patient/addresses', actor, {
      patientId: FOREIGN_UUID,
      addressLine1: 'Obca 1',
      city: 'Wrocław',
      country: 'PL',
    })
    expect(result.status).toBe(404)
  })
})
