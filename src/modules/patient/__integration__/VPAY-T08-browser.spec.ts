import { expect, test } from '@playwright/test'
import { login as browserLogin } from '@open-mercato/core/helpers/integration/auth'

async function login(page: Parameters<typeof browserLogin>[0]): Promise<void> {
  const email = process.env.OM_INTEGRATION_ADMIN_EMAIL
  const password = process.env.OM_INTEGRATION_ADMIN_PASSWORD
  if (!email) {
    await browserLogin(page, 'admin')
    return
  }
  const response = await page.request.post('/api/auth/login', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: new URLSearchParams({ email, password: password ?? '' }).toString(),
  })
  expect(response.ok()).toBe(true)
  const body = await response.json() as { token?: unknown }
  expect(typeof body.token).toBe('string')
  await page.context().addCookies([{
    name: 'auth_token', value: body.token as string, url: new URL(page.url()).origin,
    httpOnly: true, sameSite: 'Lax',
  }])
}

test.describe('VPAY-T08: staff payment and provenance browser journey', () => {
  test('generates and emails a link from the authenticated visit surface by keyboard', async ({ page }, testInfo) => {
    const visitId = crypto.randomUUID()
    const patientId = crypto.randomUUID()
    const therapistId = crypto.randomUUID()
    const productId = crypto.randomUUID()
    const serviceId = crypto.randomUUID()
    const startsAt = new Date(Date.now() + 72 * 60 * 60_000)
    const initialUpdatedAt = new Date().toISOString()
    let payment: null | Record<string, unknown> = null
    let emailQueued = false
    const browserErrors: string[] = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })

    await page.goto('/')
    await login(page)
    await page.route('**/api/auth/feature-check', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ granted: ['patient.visits.view', 'patient.visits.manage', 'patient.visits.correct', 'patient.visits.settle'] }),
    }))
    await page.route(`**/api/patient/visits/${visitId}/payment-link/email`, (route) => {
      emailQueued = true
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, updatedAt: initialUpdatedAt, paymentLink: payment, paymentLinkError: null,
        paymentLinkEmailQueued: true, paymentLinkEmailError: null,
      }) })
    })
    await page.route(`**/api/patient/visits/${visitId}/payment-link`, (route) => {
      payment = {
        linkId: crypto.randomUUID(), slug: 'visit-payment',
        url: 'https://checkout.example.test/pay/visit-payment', status: 'pending',
        receivedAt: null, configurationError: false,
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, updatedAt: initialUpdatedAt,
        paymentLink: { id: payment.linkId, slug: payment.slug, url: payment.url, status: payment.status },
        paymentLinkError: null,
      }) })
    })
    await page.route('**/api/patient/visits/availability-check?**', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ conflicts: [], worstSeverity: null, checkedAt: new Date().toISOString() }),
    }))
    await page.route('**/api/patient/visits?**', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{
        id: visitId, patientId, patientName: 'Alicja Kowalska',
        teamMemberId: therapistId, teamMemberName: 'Elżbieta Sokołowska', resourceId: null, resourceName: 'Gabinet logopedy',
        startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(), timeZone: 'Europe/Warsaw',
        status: 'planned', confirmedAt: new Date().toISOString(), isConfirmed: true, confirmationApplicable: true,
        isSettled: false, settledAt: null,
        services: [{ id: serviceId, productId, title: 'Diagnoza logopedyczna', sku: 'TEST-SERVICE', isAvailable: true, position: 0 }],
        payment, updatedAt: initialUpdatedAt, conflictOverrideCodes: [],
      }], total: 1, page: 1, pageSize: 1, totalPages: 1 }),
    }))
    await page.route(`**/api/public-booking/visits/${visitId}/provenance`, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ onlineBooking: {
        submittedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        termsAcceptedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        privacyPolicyAcceptedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        confirmationEmailSentAt: new Date().toISOString(),
      } }),
    }))

    await page.goto(`/backend/patient/visits/${visitId}`)
    await expect(page.locator('[data-online-booking-provenance]')).toBeVisible()
    const generate = page.getByRole('button', { name: /Wygeneruj link|Generate link/i })
    await generate.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByLabel(/Link do płatności|Payment address/i)).toHaveValue('https://checkout.example.test/pay/visit-payment')
    const send = page.getByRole('button', { name: /Wyślij.*e-mail|Send by email/i })
    await send.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => emailQueued).toBe(true)
    expect(browserErrors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('visit-payment-and-provenance-wide.png'), fullPage: true })
  })
})
