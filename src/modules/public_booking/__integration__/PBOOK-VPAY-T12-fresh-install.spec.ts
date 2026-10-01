import { expect, test, type APIRequestContext } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'

type PublicService = {
  id: string
  title: string
  durationMinutes: number
  price: { currency: string; amount: string }
}

type PublicTherapist = { id: string; displayName: string }
type PublicSlot = { startsAt: string; endsAt: string; timeZone: 'Europe/Warsaw' }
type Visit = {
  id: string
  patientName: string | null
  startsAt: string
  updatedAt: string
  payment: { linkId: string; slug: string; status: string } | null
}

type PaymentAction = {
  ok: true
  updatedAt: string
  paymentLink: { id: string; slug: string; url: string; status: string } | null
  paymentLinkError: { code: string; message: string } | null
  paymentLinkEmailQueued?: boolean
  paymentLinkEmailError?: { code: string; message: string } | null
}

function futureRange(): { from: string; to: string } {
  return {
    from: new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString(),
    to: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
  }
}

async function adminHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const email = process.env.OM_INTEGRATION_ADMIN_EMAIL
  const password = process.env.OM_INTEGRATION_ADMIN_PASSWORD
  const token = email
    ? await getAuthToken(request, email, password)
    : await getAuthToken(request, 'admin')
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

test.describe('PBOOK/VPAY-T12: fresh-install booking and payment journey', () => {
  test('books a seeded service once under a race, confirms it, queues its payment email, and deactivates the unpaid link', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    test.setTimeout(90_000)
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin
    const servicesResponse = await request.get('/api/public/booking/services')
    expect(servicesResponse.status()).toBe(200)
    const services = await servicesResponse.json() as PublicService[]
    expect(services.length).toBeGreaterThan(0)
    expect(services[0]).toMatchObject({
      durationMinutes: expect.any(Number),
      price: { currency: 'PLN', amount: expect.any(String) },
    })
    const service = services[0]!

    const therapistsResponse = await request.get(
      `/api/public/booking/services/${encodeURIComponent(service.id)}/therapists`,
    )
    expect(therapistsResponse.status()).toBe(200)
    const therapists = await therapistsResponse.json() as PublicTherapist[]
    expect(therapists.length).toBeGreaterThan(0)
    const therapist = therapists[0]!

    const range = futureRange()
    const availabilityResponse = await request.get('/api/public/booking/availability', {
      params: { productId: service.id, teamMemberId: therapist.id, ...range },
    })
    expect(availabilityResponse.status()).toBe(200)
    const availability = await availabilityResponse.json() as { slots: PublicSlot[]; degraded?: true }
    expect(availability.degraded).toBeUndefined()
    expect(availability.slots.length).toBeGreaterThan(0)
    const slot = availability.slots[0]!
    expect(slot.timeZone).toBe('Europe/Warsaw')
    expect(slot.startsAt).toMatch(/[+-]\d{2}:\d{2}$/)

    const timestamp = Date.now()
    const suffix = `${timestamp}-${crypto.randomUUID().slice(0, 8)}`
    const patientName = `Dziecko Realne ${suffix}`
    const payload = {
      productId: service.id,
      teamMemberId: therapist.id,
      ...slot,
      requester: {
        firstName: 'Jan',
        lastName: `Opiekun-${suffix}`,
        email: `booking-${suffix}@example.test`,
        phone: `+48 500 ${String(timestamp).slice(-3)} 222`,
      },
      patient: {
        firstName: 'Dziecko',
        lastName: `Realne ${suffix}`,
        address: { street: 'Testowa 1', postalCode: '50-001', city: 'Wrocław', country: 'PL' },
      },
      consents: { terms: true, privacyPolicy: true },
    }
    const bookingHeaders = (key: string) => ({
      'content-type': 'application/json',
      origin,
      'idempotency-key': key,
    })
    const contenderKeys = [`fresh-install-a-${suffix}`, `fresh-install-b-${suffix}`]
    const contenders = await Promise.all(contenderKeys.map((key) => request.post(
      '/api/public/booking/requests',
      { headers: bookingHeaders(key), data: payload },
    )))
    const contenderStatuses = contenders.map((response) => response.status()).sort()
    if (contenderStatuses.join(',') !== '201,409') {
      const errors = await Promise.all(contenders.map(async (response) => ({
        status: response.status(),
        body: await response.text(),
      })))
      throw new Error(`Unexpected booking race responses: ${JSON.stringify(errors)}`)
    }
    expect(contenderStatuses).toEqual([201, 409])
    const acceptedIndex = contenders.findIndex((response) => response.status() === 201)
    expect(acceptedIndex).toBeGreaterThanOrEqual(0)

    const replay = await request.post('/api/public/booking/requests', {
      headers: bookingHeaders(contenderKeys[acceptedIndex]!),
      data: payload,
    })
    expect(replay.status()).toBe(201)
    expect(await replay.json()).toEqual({ ok: true })

    const headers = await adminHeaders(request)
    const visitsResponse = await request.get('/api/patient/visits', {
      headers,
      params: {
        teamMemberId: therapist.id,
        from: new Date(Date.parse(slot.startsAt) - 60_000).toISOString(),
        to: new Date(Date.parse(slot.endsAt) + 60_000).toISOString(),
        pageSize: '20',
      },
    })
    expect(visitsResponse.status()).toBe(200)
    const visits = await visitsResponse.json() as { items: Visit[] }
    const visit = visits.items.find((item) => item.patientName === patientName)
    expect(visit, `created public visit for ${patientName}`).toBeDefined()
    expect(Date.parse(visit!.startsAt)).toBe(Date.parse(slot.startsAt))

    const confirmation = await request.post(`/api/patient/visits/${visit!.id}/confirmation`, {
      headers,
      data: { confirmed: true, expectedUpdatedAt: visit!.updatedAt, sendPaymentLinkEmail: false },
    })
    expect(confirmation.status()).toBe(200)
    const confirmed = await confirmation.json() as PaymentAction
    expect(confirmed.paymentLinkError).toBeNull()
    expect(confirmed.paymentLink).toMatchObject({
      id: expect.any(String),
      slug: expect.any(String),
      url: expect.stringContaining('/pay/'),
      status: 'pending',
    })
    expect(new URL(confirmed.paymentLink!.url).origin).toBe(origin)

    const browserErrors: string[] = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    const payResponse = await page.goto(confirmed.paymentLink!.url, { waitUntil: 'networkidle' })
    expect(payResponse?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: service.title })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('fresh-install-payment-link.png'), fullPage: true })
    expect(browserErrors).toEqual([])

    const emailKey = `fresh-install-email-${suffix}`
    const emailResponse = await request.post(`/api/patient/visits/${visit!.id}/payment-link/email`, {
      headers: { ...headers, 'idempotency-key': emailKey },
      data: { expectedUpdatedAt: confirmed.updatedAt },
    })
    expect(emailResponse.status()).toBe(200)
    const emailResult = await emailResponse.json() as PaymentAction
    expect(emailResult.paymentLinkEmailQueued).toBe(true)
    expect(emailResult.paymentLinkEmailError).toBeNull()
    expect(emailResult.paymentLink?.id).toBe(confirmed.paymentLink!.id)

    const emailReplay = await request.post(`/api/patient/visits/${visit!.id}/payment-link/email`, {
      headers: { ...headers, 'idempotency-key': emailKey },
      data: { expectedUpdatedAt: emailResult.updatedAt },
    })
    expect(emailReplay.status()).toBe(200)
    expect((await emailReplay.json() as PaymentAction).paymentLinkEmailQueued).toBe(true)

    const unconfirmation = await request.post(`/api/patient/visits/${visit!.id}/confirmation`, {
      headers,
      data: { confirmed: false, expectedUpdatedAt: emailResult.updatedAt },
    })
    expect(unconfirmation.status()).toBe(200)
    const unconfirmed = await unconfirmation.json() as PaymentAction
    expect(unconfirmed.paymentLinkError).toBeNull()
    expect(unconfirmed.paymentLink?.status).toBe('inactive')
  })
})
