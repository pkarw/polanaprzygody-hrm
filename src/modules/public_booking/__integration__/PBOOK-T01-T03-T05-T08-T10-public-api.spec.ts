import { expect, test } from '@playwright/test'

const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999'

test.describe('PBOOK public HTTP contracts', () => {
  test('mounts the stable public paths and fails closed when service identity is unavailable', async ({ request }) => {
    const services = await request.get('/api/public/booking/services')
    expect(services.status(), 'the browser-facing path must be registered, never a generated module-prefixed 404')
      .not.toBe(404)
    expect(services.headers()['content-type']).toContain('application/json')

    if (services.status() === 503) {
      expect(await services.json()).toMatchObject({ code: 'service_identity_unavailable' })
    } else {
      expect(services.status()).toBe(200)
      expect(Array.isArray(await services.json())).toBe(true)
    }

    const provenance = await request.get(`/api/public-booking/visits/${UNKNOWN_ID}/provenance`)
    expect(provenance.status()).toBe(401)
  })

  test('rejects malformed availability before it can widen a scoped read', async ({ request }) => {
    const response = await request.get('/api/public/booking/availability?productId=not-a-uuid')
    expect(response.status()).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'Invalid availability parameters' })
  })

  test('rejects untrusted origins and missing idempotency before any booking write', async ({ request, baseURL }) => {
    const untrusted = await request.post('/api/public/booking/requests', {
      headers: {
        host: new URL(baseURL ?? 'http://localhost:3000').host,
        origin: 'https://untrusted.example.test',
      },
      data: {},
    })
    expect(untrusted.status()).toBe(403)

    const trustedOrigin = new URL(baseURL ?? 'http://localhost:3000').origin
    const missingIdempotency = await request.post('/api/public/booking/requests', {
      headers: { origin: trustedOrigin },
      data: {},
    })
    expect(missingIdempotency.status()).toBe(400)
    expect(await missingIdempotency.json()).toMatchObject({
      error: 'Idempotency-Key must be between 16 and 128 characters',
    })
  })

  test('returns the same bounded refusal under concurrent invalid retries', async ({ request, baseURL }) => {
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin
    const attempt = () => request.post('/api/public/booking/requests', {
      headers: { origin },
      data: {},
    })
    const responses = await Promise.all([attempt(), attempt()])
    expect(responses.map((response) => response.status())).toEqual([400, 400])
    for (const response of responses) {
      const body = await response.json()
      expect(body).toEqual({ error: 'Idempotency-Key must be between 16 and 128 characters' })
      expect(JSON.stringify(body)).not.toContain('tenant')
      expect(JSON.stringify(body)).not.toContain('organization')
    }
  })
})
