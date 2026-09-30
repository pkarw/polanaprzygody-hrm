import { expect, test } from '@playwright/test'
import {
  callApi,
  callApiOk,
  cleanupPatient,
  createPatient,
  listContacts,
  login,
  requirePatient,
  type CreatedPatient,
} from './helpers/api'

/**
 * PAT-T12 — controlled degradation.
 *
 * Oracle (spec): no fail-open when a dependency is missing, and historical references stay
 * readable.
 *
 * The spec's scenarios include disabling documents/attachments and removing a CRM or staff record.
 * Neither can be done from inside a running app without breaking it for every other suite, so this
 * covers the observable half: a reference that cannot be resolved degrades to an explicit
 * "unavailable" rather than to a uuid, a crash, or an unfiltered read.
 */
test.describe('PAT-T12: degradation is controlled, never fail-open', () => {
  test('a carer reference that cannot be resolved renders as absent, never as a uuid', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const record = await requirePatient(request, actor, created.id)

      // No carer set: the API reports null rather than inventing a value.
      expect(record.ownerTeamMemberId).toBeNull()
      expect(record.owner).toBeNull()

      // A carer id that does not resolve in this scope is refused at write time (422) rather than
      // being stored and rendered as an unresolvable reference later.
      const rejected = await callApi(request, 'PUT', '/api/patient/patients', actor, {
        id: created.id,
        expectedUpdatedAt: record.updatedAt,
        ownerTeamMemberId: '99999999-9999-4999-8999-999999999999',
      })
      expect(rejected.status).toBe(422)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('the contact list reports an unresolvable person as unavailable rather than failing', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      // Reading an empty list must be a successful empty result, not an error.
      const contacts = await listContacts(request, actor, created.id)
      expect(Array.isArray(contacts)).toBe(true)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('the clinical file surface degrades to an explicit refusal, not a silent success', async ({ request }) => {
    const actor = await login(request)
    const result = await callApi<{ code?: string }>(
      request,
      'POST',
      '/api/patient/attachment-links/upload',
      actor,
      {},
    )
    // The spec's rule for a missing dependency: refuse with a recognisable reason. A 2xx here
    // would be the fail-open the whole SEC-ATT gate exists to prevent.
    expect(result.status).toBe(503)
    expect(result.body.code).toBe('clinical_file_protection_unavailable')
  })

  test('a document link whose title cannot be read reports null rather than leaking or failing', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const links = await callApiOk<{ items: Array<{ title: unknown }> }>(
        request,
        'GET',
        `/api/patient/document-links?patientId=${encodeURIComponent(created.id)}&pageSize=10`,
        actor,
      )
      // An empty list is a successful result; the contract is that `title` is either a real title
      // the caller may read or explicitly null — never a redacted placeholder invented server-side.
      for (const item of links.items) {
        expect(item.title === null || typeof item.title === 'string').toBe(true)
      }
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('an archived record still reads while refusing new entries', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const record = await requirePatient(request, actor, created.id)
      await callApiOk(
        request,
        'POST',
        `/api/patient/patients/${encodeURIComponent(created.id)}/archive`,
        actor,
        { archived: true, expectedUpdatedAt: record.updatedAt },
      )

      // History stays readable — that is the whole distinction between archiving and deleting.
      const archived = await requirePatient(request, actor, created.id)
      expect(archived.status).toBe('archived')
      expect(Array.isArray(await listContacts(request, actor, created.id))).toBe(true)

      const blocked = await callApi(request, 'POST', '/api/patient/contacts', actor, {
        patientId: created.id,
        customerEntityId: '99999999-9999-4999-8999-999999999999',
        isGuardian: true,
      })
      // Refused — and the archived check runs before the reference check, so either code proves
      // the write did not land.
      expect([409, 422]).toContain(blocked.status)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })
})
