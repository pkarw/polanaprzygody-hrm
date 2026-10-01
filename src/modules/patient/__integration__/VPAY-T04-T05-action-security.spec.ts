import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'

const UNKNOWN_VISIT = '99999999-9999-4999-8999-999999999999'

async function integrationToken(request: Parameters<typeof getAuthToken>[0]): Promise<string> {
  const email = process.env.OM_INTEGRATION_ADMIN_EMAIL
  const password = process.env.OM_INTEGRATION_ADMIN_PASSWORD
  return email
    ? await getAuthToken(request, email, password)
    : await getAuthToken(request, 'admin')
}

test.describe('VPAY staff payment action security', () => {
  test('requires authentication on create, email, and confirmation payment paths', async ({ request }) => {
    for (const path of [
      `/api/patient/visits/${UNKNOWN_VISIT}/payment-link`,
      `/api/patient/visits/${UNKNOWN_VISIT}/payment-link/email`,
      `/api/patient/visits/${UNKNOWN_VISIT}/confirmation`,
    ]) {
      const response = await request.post(path, { data: { expectedUpdatedAt: '2026-10-01T09:00:00.000Z' } })
      expect(response.status(), `${path} must not expose payment state anonymously`).toBe(401)
    }
  })

  test('applies feature gating before returning any visit payment state', async ({ request }) => {
    const token = await integrationToken(request)
    const headers = { authorization: `Bearer ${token}` }
    for (const path of [
      `/api/patient/visits/${UNKNOWN_VISIT}/payment-link`,
      `/api/patient/visits/${UNKNOWN_VISIT}/payment-link/email`,
    ]) {
      const response = await request.post(path, {
        headers,
        data: { expectedUpdatedAt: '2026-10-01T09:00:00.000Z' },
      })
      expect([403, 404]).toContain(response.status())
      const body = await response.text()
      expect(body).not.toContain('payment_link_id')
      expect(body).not.toContain('payment_link_slug')
    }
  })
})
