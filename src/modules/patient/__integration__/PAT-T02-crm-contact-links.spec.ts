import { expect, test } from '@playwright/test'
import {
  callApi,
  callApiOk,
  cleanupPatient,
  createPatient,
  findCrmPersonId,
  listContacts,
  login,
  requirePatient,
  type CreatedPatient,
} from './helpers/api'

/**
 * PAT-T02 — CRM contact links.
 *
 * Oracle (spec): 0..n links, uniqueness of an active pair, independent role flags, and the CRM
 * record surviving an unlink.
 */
test.describe('PAT-T02: CRM contact links', () => {
  test('a patient may have zero contacts', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      // Zero is a valid record, not an unfinished one.
      expect(await listContacts(request, actor, created.id)).toHaveLength(0)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('links a person with combined roles and resolves their display name', async ({ request }) => {
    const actor = await login(request)
    const personId = await findCrmPersonId(request, actor)
    test.skip(!personId, 'This organization has no active CRM person to link.')

    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      await callApiOk(request, 'POST', '/api/patient/contacts', actor, {
        patientId: created.id,
        customerEntityId: personId,
        // Independent flags: a guardian who is also the payer and the primary contact.
        isGuardian: true,
        isContact: true,
        isPayer: true,
        isPrimaryContact: true,
        relationshipLabel: 'matka',
      })

      const contacts = await listContacts(request, actor, created.id)
      expect(contacts).toHaveLength(1)
      expect(contacts[0].isGuardian && contacts[0].isContact && contacts[0].isPayer).toBe(true)
      expect(contacts[0].isPrimaryContact).toBe(true)
      // A display name, resolved on read rather than copied at write time — and never a uuid.
      expect(contacts[0].person?.name).toBeTruthy()
      expect(contacts[0].person?.name).not.toBe(personId)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses a second active link for the same pair, and allows it again after unlinking', async ({ request }) => {
    const actor = await login(request)
    const personId = await findCrmPersonId(request, actor)
    test.skip(!personId, 'This organization has no active CRM person to link.')

    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const link = await callApiOk<{ id: string; updatedAt: string | null }>(
        request,
        'POST',
        '/api/patient/contacts',
        actor,
        { patientId: created.id, customerEntityId: personId, isGuardian: true },
      )

      const duplicate = await callApi(request, 'POST', '/api/patient/contacts', actor, {
        patientId: created.id,
        customerEntityId: personId,
        isContact: true,
      })
      expect(duplicate.status).toBe(409)

      await callApiOk(request, 'DELETE', '/api/patient/contacts', actor, {
        id: link.id,
        expectedUpdatedAt: link.updatedAt,
      })
      expect(await listContacts(request, actor, created.id)).toHaveLength(0)

      // Re-linking is legal and creates a NEW row, because the old link records a relationship
      // that existed during a period of care.
      const relinked = await callApiOk<{ id: string }>(request, 'POST', '/api/patient/contacts', actor, {
        patientId: created.id,
        customerEntityId: personId,
        isGuardian: true,
      })
      expect(relinked.id).not.toBe(link.id)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('unlinking leaves the CRM person untouched', async ({ request }) => {
    const actor = await login(request)
    const personId = await findCrmPersonId(request, actor)
    test.skip(!personId, 'This organization has no active CRM person to link.')

    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const link = await callApiOk<{ id: string; updatedAt: string | null }>(
        request,
        'POST',
        '/api/patient/contacts',
        actor,
        { patientId: created.id, customerEntityId: personId, isContact: true },
      )
      await callApiOk(request, 'DELETE', '/api/patient/contacts', actor, {
        id: link.id,
        expectedUpdatedAt: link.updatedAt,
      })

      // The spec forbids cascading into customers: the person must still be readable.
      const person = await callApi(
        request,
        'GET',
        `/api/customers/people?ids=${encodeURIComponent(String(personId))}&pageSize=1`,
        actor,
      )
      expect(person.status).toBe(200)
      expect((person.body as { items?: unknown[] }).items?.length).toBe(1)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses a link with no role and a primary contact that is not a contact', async ({ request }) => {
    const actor = await login(request)
    const personId = await findCrmPersonId(request, actor)
    test.skip(!personId, 'This organization has no active CRM person to link.')

    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)

      const noRole = await callApi(request, 'POST', '/api/patient/contacts', actor, {
        patientId: created.id,
        customerEntityId: personId,
      })
      expect(noRole.status).toBe(400)

      const inconsistentPrimary = await callApi(request, 'POST', '/api/patient/contacts', actor, {
        patientId: created.id,
        customerEntityId: personId,
        isPayer: true,
        isPrimaryContact: true,
      })
      expect(inconsistentPrimary.status).toBe(400)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses a foreign or unknown person reference with 422', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      // A well-formed uuid that is not an active CRM person of this scope. 422, not 404: the
      // patient is visible, the reference is unusable.
      const result = await callApi(request, 'POST', '/api/patient/contacts', actor, {
        patientId: created.id,
        customerEntityId: '99999999-9999-4999-8999-999999999999',
        isGuardian: true,
      })
      expect(result.status).toBe(422)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('records guardians supplied with the record, in the same create', async ({ request }) => {
    const actor = await login(request)
    const personId = await findCrmPersonId(request, actor)
    test.skip(!personId, 'This organization has no active CRM person to link.')

    let created: CreatedPatient | null = null
    try {
      // The user-requested flow: a child arrives with a parent, and both are entered at once.
      created = await createPatient(request, actor, {
        contacts: [
          {
            customerEntityId: personId,
            isGuardian: true,
            isContact: true,
            isPrimaryContact: true,
            relationshipLabel: 'matka',
          },
        ],
      })

      const contacts = await listContacts(request, actor, created.id)
      expect(contacts).toHaveLength(1)
      expect(contacts[0].isGuardian).toBe(true)
      expect(contacts[0].isPrimaryContact).toBe(true)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses the whole create when a supplied guardian is not usable', async ({ request }) => {
    const actor = await login(request)
    const before = await callApiOk<{ total?: number }>(
      request,
      'GET',
      '/api/patient/patients?pageSize=1',
      actor,
    )

    const result = await callApi(request, 'POST', '/api/patient/patients', actor, {
      firstName: 'Nie',
      lastName: 'Powinien',
      email: 'nie-powinien@example.test',
      primaryAddress: { addressLine1: 'Testowa 1', city: 'Wrocław', country: 'PL' },
      contacts: [{ customerEntityId: '99999999-9999-4999-8999-999999999999', isGuardian: true }],
      clientRequestId: crypto.randomUUID(),
    })
    // All-or-nothing: the record and the people responsible for it are one fact.
    expect(result.status).toBe(422)

    const after = await callApiOk<{ total?: number }>(
      request,
      'GET',
      '/api/patient/patients?pageSize=1',
      actor,
    )
    expect(after.total ?? 0).toBe(before.total ?? 0)
  })
})
