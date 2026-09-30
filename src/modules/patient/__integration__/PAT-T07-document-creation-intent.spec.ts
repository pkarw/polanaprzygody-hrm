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
 * PAT-T07 — the resumable document-creation intent.
 *
 * Oracle (spec): one document, one intent/link, a visible pending state, and no duplicate event.
 */
test.describe('PAT-T07: document creation intent', () => {
  test('creates a document from the card and links it', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const result = await callApi<{ linkId?: string; documentId?: string; state?: string }>(
        request,
        'POST',
        '/api/patient/document-links/new',
        actor,
        { patientId: created.id, title: unique('nowy'), clientRequestId: newRequestId() },
      )
      test.skip(result.status === 403, 'This actor lacks documents.create.')
      // 201 when the document is confirmed, 202 when the intent is recorded but not completed.
      expect([201, 202]).toContain(result.status)

      const links = await listDocumentLinks(request, actor, created.id)
      expect(links).toHaveLength(1)
      expect(links[0].id).toBe(result.body.linkId)
      expect(['linked', 'pending_create']).toContain(links[0].state)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('a repeated create with the same request id resumes the SAME intent, never a second document', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const clientRequestId = newRequestId()
      const payload = { patientId: created.id, title: unique('retry'), clientRequestId }

      const first = await callApi<{ linkId?: string; documentId?: string }>(
        request,
        'POST',
        '/api/patient/document-links/new',
        actor,
        payload,
      )
      test.skip(first.status === 403, 'This actor lacks documents.create.')
      expect([201, 202]).toContain(first.status)

      const retry = await callApi<{ linkId?: string; documentId?: string }>(
        request,
        'POST',
        '/api/patient/document-links/new',
        actor,
        payload,
      )
      expect([200, 201, 202]).toContain(retry.status)

      // The ids are fixed by the intent, so a retry can only ever land on the same document.
      expect(retry.body.linkId).toBe(first.body.linkId)
      expect(retry.body.documentId).toBe(first.body.documentId)
      expect(await listDocumentLinks(request, actor, created.id)).toHaveLength(1)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('a reused request id with a different title is a conflict', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const clientRequestId = newRequestId()
      const first = await callApi(request, 'POST', '/api/patient/document-links/new', actor, {
        patientId: created.id,
        title: unique('pierwszy'),
        clientRequestId,
      })
      test.skip(first.status === 403, 'This actor lacks documents.create.')

      const conflicting = await callApi(request, 'POST', '/api/patient/document-links/new', actor, {
        patientId: created.id,
        title: unique('drugi'),
        clientRequestId,
      })
      expect(conflicting.status).toBe(409)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('resuming a completed link is idempotent', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const first = await callApi<{ linkId?: string; documentId?: string }>(
        request,
        'POST',
        '/api/patient/document-links/new',
        actor,
        { patientId: created.id, title: unique('wznow'), clientRequestId: newRequestId() },
      )
      test.skip(first.status === 403, 'This actor lacks documents.create.')

      const [link] = await listDocumentLinks(request, actor, created.id)
      const resumed = await callApi<{ documentId?: string }>(
        request,
        'POST',
        `/api/patient/document-links/${encodeURIComponent(link.id)}/resume`,
        actor,
        { expectedUpdatedAt: link.updatedAt },
      )
      // Resuming an already-linked intent is a no-op, not an error — the whole point is that the
      // client can retry without having to know which half succeeded.
      expect([200, 202]).toContain(resumed.status)
      expect(resumed.body.documentId).toBe(link.documentId)
      expect(await listDocumentLinks(request, actor, created.id)).toHaveLength(1)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('an unfinished intent blocks unpinning until it is abandoned', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const result = await callApi<{ state?: string }>(
        request,
        'POST',
        '/api/patient/document-links/new',
        actor,
        { patientId: created.id, title: unique('pending'), clientRequestId: newRequestId() },
      )
      test.skip(result.status === 403, 'This actor lacks documents.create.')
      test.skip(
        result.body?.state !== 'pending_create',
        'The document completed synchronously on this host, so there is no pending intent to exercise.',
      )

      const [link] = await listDocumentLinks(request, actor, created.id)
      const unpin = await callApi(request, 'DELETE', '/api/patient/document-links', actor, {
        id: link.id,
        expectedUpdatedAt: link.updatedAt,
      })
      // Clearing an unfinished intent is abandon's job: it is a decision about a document that
      // may exist, not a plain unlink.
      expect(unpin.status).toBe(409)

      await callApiOk(
        request,
        'POST',
        `/api/patient/document-links/${encodeURIComponent(link.id)}/abandon`,
        actor,
        { expectedUpdatedAt: link.updatedAt },
      )
      const after = await listDocumentLinks(request, actor, created.id)
      expect(after.find((item) => item.id === link.id)?.state).toBe('abandoned')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })
})
