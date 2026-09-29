import { expect, test } from '@playwright/test'
import {
  callApi,
  callApiOk,
  cleanupPatient,
  createPatient,
  login,
  requirePatient,
  unique,
  type CreatedPatient,
} from './helpers/api'

/**
 * PAT-T04 — patient custom fields.
 *
 * Oracle (spec): set, update, clear and re-read with no stale projection.
 *
 * The suite defines its OWN field rather than relying on one an administrator happened to create:
 * the spec requires every case to be self-contained, and `patient:patient` ships with no built-in
 * custom field on purpose.
 */
test.describe('PAT-T04: patient custom fields', () => {
  const fieldKey = `pat_t04_${unique('f').replace(/-/g, '_')}`

  test('sets, updates, clears and re-reads a custom field without a stale value', async ({ request }) => {
    const actor = await login(request)

    // Define the field through the entities module's own API. A failure here is an environment
    // problem, not a patient-module defect, so the spec skips rather than reports a false failure.
    const definition = await callApi(request, 'POST', '/api/entities/fields', actor, {
      entityId: 'patient:patient',
      key: fieldKey,
      kind: 'text',
      label: 'PAT-T04 probe',
      formEditable: true,
      filterable: true,
    })
    test.skip(
      definition.status < 200 || definition.status >= 300,
      `Could not define a custom field (${definition.status}); the entities API may differ on this host.`,
    )

    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)

      // Set
      const record = await requirePatient(request, actor, created.id)
      await callApiOk(request, 'PUT', '/api/patient/patients', actor, {
        id: created.id,
        expectedUpdatedAt: record.updatedAt,
        [`cf_${fieldKey}`]: 'pierwsza',
      })
      let read = (await requirePatient(request, actor, created.id)) as unknown as Record<string, unknown>
      expect(read[`cf_${fieldKey}`]).toBe('pierwsza')

      // Update
      await callApiOk(request, 'PUT', '/api/patient/patients', actor, {
        id: created.id,
        expectedUpdatedAt: (read as { updatedAt?: string }).updatedAt,
        [`cf_${fieldKey}`]: 'druga',
      })
      read = (await requirePatient(request, actor, created.id)) as unknown as Record<string, unknown>
      expect(read[`cf_${fieldKey}`]).toBe('druga')

      // Clear — the assertion that matters, because a stale index or a truthy fallback shows up
      // here and nowhere else.
      await callApiOk(request, 'PUT', '/api/patient/patients', actor, {
        id: created.id,
        expectedUpdatedAt: (read as { updatedAt?: string }).updatedAt,
        [`cf_${fieldKey}`]: null,
      })
      read = (await requirePatient(request, actor, created.id)) as unknown as Record<string, unknown>
      expect(read[`cf_${fieldKey}`] ?? null).toBeNull()
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('sets a custom field during the atomic create', async ({ request }) => {
    const actor = await login(request)
    const definition = await callApi(request, 'POST', '/api/entities/fields', actor, {
      entityId: 'patient:patient',
      key: `${fieldKey}_create`,
      kind: 'text',
      label: 'PAT-T04 create probe',
      formEditable: true,
    })
    test.skip(
      definition.status < 200 || definition.status >= 300,
      `Could not define a custom field (${definition.status}); the entities API may differ on this host.`,
    )

    let created: CreatedPatient | null = null
    try {
      const body = await callApiOk<CreatedPatient>(request, 'POST', '/api/patient/patients', actor, {
        firstName: 'Custom',
        lastName: unique('field'),
        email: `${unique('cf')}@example.test`,
        primaryAddress: { addressLine1: 'Testowa 1', city: 'Wrocław', country: 'PL' },
        [`cf_${fieldKey}_create`]: 'ustawione przy tworzeniu',
        clientRequestId: crypto.randomUUID(),
      })
      created = body

      const read = (await requirePatient(request, actor, created.id)) as unknown as Record<string, unknown>
      // Custom fields are written after the transaction commits, so this also proves the
      // post-commit write actually ran rather than being swallowed.
      expect(read[`cf_${fieldKey}_create`]).toBe('ustawione przy tworzeniu')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })
})
