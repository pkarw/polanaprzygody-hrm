import { expect, test } from '@playwright/test'
import { callApi, login } from './helpers/api'

/**
 * PAT-T09 — the file-access denial matrix.
 *
 * The spec's oracle is "no bytes, no thumbnails, no names, no metadata" for an unauthorized
 * caller across every host entry point. On this installed host that guarantee CANNOT be met — the
 * attachments module authorizes downloads by tenant and organization scope alone — which is
 * precisely why clinical file storage is refused rather than shipped.
 *
 * So this suite asserts the only thing that is actually true and actually protective here: this
 * module stores no clinical file, and its own file endpoints disclose nothing. The host's
 * behaviour that makes storing one unsafe is pinned separately, as an executable assertion, in
 * `../__tests__/clinicalFileGate.test.ts` — inverted on purpose, so a host version that fixes it
 * fails that test and prompts this phase to be re-evaluated.
 */
test.describe('PAT-T09: patient file endpoints disclose nothing', () => {
  test('refuses an anonymous caller on every patient file endpoint', async ({ request }) => {
    for (const [method, path] of [
      ['GET', '/api/patient/attachment-links?patientId=99999999-9999-4999-8999-999999999999'],
      ['POST', '/api/patient/attachment-links/upload'],
      ['GET', '/api/patient/attachment-links/99999999-9999-4999-8999-999999999999/file'],
    ] as const) {
      const result = await callApi(request, method, path, null, method === 'POST' ? {} : undefined)
      // Never 200, and never a body that reveals whether the id exists.
      expect(result.status, `${method} ${path}`).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(result.body)).not.toContain('storagePath')
    }
  })

  test('discloses nothing about an attachment id an authorized caller supplies', async ({ request }) => {
    const actor = await login(request)
    const result = await callApi(
      request,
      'GET',
      '/api/patient/attachment-links/99999999-9999-4999-8999-999999999999/file',
      actor,
    )
    // The gate answers before any lookup, so the response is identical whether or not the id
    // exists — it cannot be used to probe for one.
    expect(result.status).toBe(503)
    const serialized = JSON.stringify(result.body)
    expect(serialized).not.toContain('storagePath')
    expect(serialized).not.toContain('mimeType')
    expect(serialized).not.toContain('fileName')
  })

  test('a diagnosis id from another patient cannot be attached', async ({ request }) => {
    const actor = await login(request)
    // Refused by the gate before the cross-patient check is even reached; both refusals are
    // correct, and neither leaks whether the diagnosis exists.
    const result = await callApi(request, 'POST', '/api/patient/attachment-links', actor, {
      patientId: '11111111-1111-4111-8111-111111111111',
      diagnosisId: '22222222-2222-4222-8222-222222222222',
      attachmentId: '33333333-3333-4333-8333-333333333333',
      clientRequestId: crypto.randomUUID(),
    })
    expect([404, 422, 503]).toContain(result.status)
  })
})
