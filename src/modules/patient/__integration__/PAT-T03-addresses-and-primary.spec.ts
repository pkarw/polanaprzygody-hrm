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

/**
 * PAT-T03 — addresses and the single-primary invariant.
 *
 * Oracle (spec): exactly one primary, a 409 on removing the last address, and no partial change.
 */
test.describe('PAT-T03: addresses and the primary invariant', () => {
  test('promoting a second address demotes the first, atomically', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const second = await callApiOk<{ id: string; updatedAt: string | null }>(
        request,
        'POST',
        '/api/patient/addresses',
        actor,
        { patientId: created.id, addressLine1: 'Druga 2', city: 'Wrocław', country: 'PL' },
      )

      // A later address is not primary just for existing.
      let addresses = await listAddresses(request, actor, created.id)
      expect(addresses.filter((address) => address.isPrimary)).toHaveLength(1)

      await callApiOk(request, 'PUT', '/api/patient/addresses', actor, {
        id: second.id,
        expectedUpdatedAt: second.updatedAt,
        isPrimary: true,
      })

      addresses = await listAddresses(request, actor, created.id)
      // Exactly one, still — the demotion and the promotion are one transaction.
      expect(addresses.filter((address) => address.isPrimary)).toHaveLength(1)
      expect(addresses.find((address) => address.isPrimary)?.id).toBe(second.id)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses deleting the last address of an active record', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const [only] = await listAddresses(request, actor, created.id)

      const result = await callApi(request, 'DELETE', '/api/patient/addresses', actor, {
        id: only.id,
        expectedUpdatedAt: only.updatedAt,
      })
      expect(result.status).toBe(409)
      // Nothing partial: the address is still there and still primary.
      const after = await listAddresses(request, actor, created.id)
      expect(after).toHaveLength(1)
      expect(after[0].isPrimary).toBe(true)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses deleting the primary address while others remain, and allows it after promoting another', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const second = await callApiOk<{ id: string; updatedAt: string | null }>(
        request,
        'POST',
        '/api/patient/addresses',
        actor,
        { patientId: created.id, addressLine1: 'Druga 2', city: 'Wrocław', country: 'PL' },
      )

      let addresses = await listAddresses(request, actor, created.id)
      const primary = addresses.find((address) => address.isPrimary)!

      // Deleting it would leave the record with addresses and no primary; the refusal names the
      // remedy rather than silently promoting whichever row sorts first.
      const refused = await callApi(request, 'DELETE', '/api/patient/addresses', actor, {
        id: primary.id,
        expectedUpdatedAt: primary.updatedAt,
      })
      expect(refused.status).toBe(409)

      await callApiOk(request, 'PUT', '/api/patient/addresses', actor, {
        id: second.id,
        expectedUpdatedAt: second.updatedAt,
        isPrimary: true,
      })
      addresses = await listAddresses(request, actor, created.id)
      const demoted = addresses.find((address) => address.id === primary.id)!

      await callApiOk(request, 'DELETE', '/api/patient/addresses', actor, {
        id: demoted.id,
        expectedUpdatedAt: demoted.updatedAt,
      })
      const remaining = await listAddresses(request, actor, created.id)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].isPrimary).toBe(true)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('two concurrent promotions leave exactly one primary', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const a = await callApiOk<{ id: string; updatedAt: string | null }>(
        request,
        'POST',
        '/api/patient/addresses',
        actor,
        { patientId: created.id, addressLine1: 'A 1', city: 'Wrocław', country: 'PL' },
      )
      const b = await callApiOk<{ id: string; updatedAt: string | null }>(
        request,
        'POST',
        '/api/patient/addresses',
        actor,
        { patientId: created.id, addressLine1: 'B 2', city: 'Wrocław', country: 'PL' },
      )

      // Fired together: the patient lock serializes them, and the partial unique index is the
      // backstop. Either order is acceptable; two primaries never are.
      await Promise.allSettled([
        callApi(request, 'PUT', '/api/patient/addresses', actor, {
          id: a.id,
          expectedUpdatedAt: a.updatedAt,
          isPrimary: true,
        }),
        callApi(request, 'PUT', '/api/patient/addresses', actor, {
          id: b.id,
          expectedUpdatedAt: b.updatedAt,
          isPrimary: true,
        }),
      ])

      const addresses = await listAddresses(request, actor, created.id)
      expect(addresses.filter((address) => address.isPrimary)).toHaveLength(1)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('a stale version is refused with 409 and changes nothing', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const [address] = await listAddresses(request, actor, created.id)
      const staleVersion = address.updatedAt

      await callApiOk(request, 'PUT', '/api/patient/addresses', actor, {
        id: address.id,
        expectedUpdatedAt: staleVersion,
        city: 'Poznań',
      })

      // The second writer still holds the first version.
      const conflict = await callApi(request, 'PUT', '/api/patient/addresses', actor, {
        id: address.id,
        expectedUpdatedAt: staleVersion,
        city: 'Kraków',
      })
      expect(conflict.status).toBe(409)

      const after = await listAddresses(request, actor, created.id)
      expect(after[0].city).toBe('Poznań')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('a child write bumps the parent record version', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const before = await requirePatient(request, actor, created.id)

      await callApiOk(request, 'POST', '/api/patient/addresses', actor, {
        patientId: created.id,
        addressLine1: 'Trzecia 3',
        city: 'Wrocław',
        country: 'PL',
      })

      const after = await requirePatient(request, actor, created.id)
      // A card loaded before this change now holds a stale token and is told so, rather than
      // overwriting the record blind.
      expect(new Date(String(after.updatedAt)).getTime()).toBeGreaterThan(
        new Date(String(before.updatedAt)).getTime(),
      )
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })
})
