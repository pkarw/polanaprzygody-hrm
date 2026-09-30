import { expect, test } from '@playwright/test'
import {
  callApi,
  cleanupPatient,
  createPatient,
  login,
  newRequestId,
  type CreatedPatient,
} from './helpers/api'

/**
 * PAT-T08 — clinical files.
 *
 * On this installed host the phase is DISABLED, and this suite asserts that it is disabled
 * honestly rather than asserting an upload that cannot be protected. The spec's own compliance
 * report marks PAT-3 "blocked for implementation" for exactly this reason; see
 * `../lib/clinicalFileGate.ts` for the verification, and `../__tests__/clinicalFileGate.test.ts`
 * for the host-behaviour assertion that will fail — deliberately — once a supported host arrives.
 *
 * What is asserted here is the contract an operator and a client actually meet: a refusal with a
 * recognisable code, reads that still work, and detaching that is never blocked.
 */
test.describe('PAT-T08: clinical files are refused, not half-implemented', () => {
  test('refuses attaching a file with 503 and a recognisable capability code', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const result = await callApi<{ code?: string; capability?: string }>(
        request,
        'POST',
        '/api/patient/attachment-links',
        actor,
        {
          patientId: created.id,
          attachmentId: '99999999-9999-4999-8999-999999999999',
          clientRequestId: newRequestId(),
        },
      )
      // 503, not 403: the caller may be fully authorized and the capability returns with a
      // supported host, so the operator should escalate rather than request a permission.
      expect(result.status).toBe(503)
      expect(result.body.code).toBe('clinical_file_protection_unavailable')
      expect(result.body.capability).toBe('SEC-ATT')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses upload and download with the same code', async ({ request }) => {
    const actor = await login(request)
    const upload = await callApi<{ code?: string }>(
      request,
      'POST',
      '/api/patient/attachment-links/upload',
      actor,
      {},
    )
    expect(upload.status).toBe(503)
    expect(upload.body.code).toBe('clinical_file_protection_unavailable')

    const download = await callApi<{ code?: string }>(
      request,
      'GET',
      '/api/patient/attachment-links/99999999-9999-4999-8999-999999999999/file',
      actor,
    )
    expect(download.status).toBe(503)
    expect(download.body.code).toBe('clinical_file_protection_unavailable')
  })

  test('reading file links still works, so an operator can see and clear what exists', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      // Reads are NOT gated: they return this module's own metadata behind its own clinical
      // feature, never bytes or a storage URL. A deployment that stored links on a previously
      // enabled host must still be able to see and detach them.
      const result = await callApi<{ items?: unknown[] }>(
        request,
        'GET',
        `/api/patient/attachment-links?patientId=${encodeURIComponent(created.id)}&pageSize=10`,
        actor,
      )
      expect(result.status).toBe(200)
      expect(Array.isArray(result.body.items)).toBe(true)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('never returns a storage URL or raw bytes from the link list', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const result = await callApi(
        request,
        'GET',
        `/api/patient/attachment-links?patientId=${encodeURIComponent(created.id)}&pageSize=10`,
        actor,
      )
      const serialized = JSON.stringify(result.body)
      // The list must not become a way around the missing host protection.
      expect(serialized).not.toContain('storagePath')
      expect(serialized).not.toContain('storage_path')
      expect(serialized).not.toContain('/api/attachments/file/')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })
})
