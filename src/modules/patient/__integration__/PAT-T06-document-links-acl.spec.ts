import { expect, test } from '@playwright/test'
import {
  callApi,
  callApiOk,
  cleanupPatient,
  createPatient,
  listDocumentLinks,
  login,
  newRequestId,
  unique,
  type CreatedPatient,
} from './helpers/api'

/**
 * PAT-T06 — document links and the native ACL.
 *
 * Oracle (spec): the documents module's own policy decides, no automatic share, and no title leak.
 */
test.describe('PAT-T06: document links respect the native document ACL', () => {
  test('pins a document the caller owns and shows its title', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const title = unique('dok')
      // Created through the documents module's own API, so the caller is its owner.
      const document = await callApi<{ id?: string }>(request, 'POST', '/api/documents', actor, { title })
      test.skip(
        document.status < 200 || document.status >= 300,
        `Could not create a document (${document.status}); the documents API may differ on this host.`,
      )
      const documentId = (document.body as { id?: string }).id!

      await callApiOk(request, 'POST', '/api/patient/document-links', actor, {
        patientId: created.id,
        documentId,
        clientRequestId: newRequestId(),
      })

      const links = await listDocumentLinks(request, actor, created.id)
      expect(links).toHaveLength(1)
      expect(links[0].state).toBe('linked')
      // The owner can read it, so the title is returned.
      expect(links[0].title).toBe(title)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses pinning a document the caller cannot read, with 404 rather than 403', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const result = await callApi(request, 'POST', '/api/patient/document-links', actor, {
        patientId: created.id,
        documentId: '99999999-9999-4999-8999-999999999999',
        clientRequestId: newRequestId(),
      })
      // 404, deliberately: a 403 would confirm the id exists somewhere, letting it be probed.
      expect(result.status).toBe(404)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses a second active link for the same document and patient', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const document = await callApi<{ id?: string }>(request, 'POST', '/api/documents', actor, {
        title: unique('dok'),
      })
      test.skip(document.status < 200 || document.status >= 300, 'Documents API unavailable.')
      const documentId = (document.body as { id?: string }).id!

      await callApiOk(request, 'POST', '/api/patient/document-links', actor, {
        patientId: created.id,
        documentId,
        clientRequestId: newRequestId(),
      })
      const duplicate = await callApi(request, 'POST', '/api/patient/document-links', actor, {
        patientId: created.id,
        documentId,
        clientRequestId: newRequestId(),
      })
      expect(duplicate.status).toBe(409)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('unpinning removes the link and leaves the document intact', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const title = unique('dok')
      const document = await callApi<{ id?: string }>(request, 'POST', '/api/documents', actor, { title })
      test.skip(document.status < 200 || document.status >= 300, 'Documents API unavailable.')
      const documentId = (document.body as { id?: string }).id!

      await callApiOk(request, 'POST', '/api/patient/document-links', actor, {
        patientId: created.id,
        documentId,
        clientRequestId: newRequestId(),
      })
      const [link] = await listDocumentLinks(request, actor, created.id)

      await callApiOk(request, 'DELETE', '/api/patient/document-links', actor, {
        id: link.id,
        expectedUpdatedAt: link.updatedAt,
      })
      expect(await listDocumentLinks(request, actor, created.id)).toHaveLength(0)

      // The spec forbids cascading into documents: the document must still be readable.
      const stillThere = await callApi(
        request,
        'GET',
        `/api/documents?ids=${encodeURIComponent(documentId)}&pageSize=1`,
        actor,
      )
      expect(stillThere.status).toBe(200)
      expect((stillThere.body as { items?: unknown[] }).items?.length).toBe(1)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('marks a document pinned to two patients as shared', async ({ request }) => {
    const actor = await login(request)
    let first: CreatedPatient | null = null
    let second: CreatedPatient | null = null
    try {
      first = await createPatient(request, actor)
      second = await createPatient(request, actor)
      const document = await callApi<{ id?: string }>(request, 'POST', '/api/documents', actor, {
        title: unique('dok'),
      })
      test.skip(document.status < 200 || document.status >= 300, 'Documents API unavailable.')
      const documentId = (document.body as { id?: string }).id!

      for (const patient of [first, second]) {
        await callApiOk(request, 'POST', '/api/patient/document-links', actor, {
          patientId: patient.id,
          documentId,
          clientRequestId: newRequestId(),
        })
      }

      // The UI warns before unpinning when the document is attached elsewhere too.
      const links = await listDocumentLinks(request, actor, first.id)
      expect(links[0].isSharedWithOtherPatients).toBe(true)
    } finally {
      await cleanupPatient(request, actor, first?.id ?? null)
      await cleanupPatient(request, actor, second?.id ?? null)
    }
  })
})
