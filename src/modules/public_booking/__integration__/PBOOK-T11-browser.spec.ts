import { expect, test } from '@playwright/test'

test.describe('PBOOK-T11: public booking browser journey', () => {
  test('completes the accessible narrow booking flow without putting PII in the success URL', async ({ page }, testInfo) => {
    const productId = crypto.randomUUID()
    const therapistId = crypto.randomUUID()
    const startsAt = new Date(Date.now() + 72 * 60 * 60_000)
    startsAt.setMinutes(0, 0, 0)
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000)
    const browserErrors: string[] = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })

    await page.route('**/api/public/booking/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/public/booking/services') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
          id: productId,
          title: 'Diagnoza logopedyczna',
          description: 'Kompleksowa diagnoza mowy i komunikacji.',
          durationMinutes: 60,
          category: 'Diagnoza',
          price: { currency: 'PLN', amount: '249', wasAmount: '300', isPromotion: true },
        }]) })
      }
      if (url.pathname.endsWith('/therapists')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
          id: therapistId,
          displayName: 'Elżbieta Sokołowska',
          shortBio: 'Neurologopedka wspierająca dzieci i rodziny.',
          specializations: ['Logopedia', 'Neurologopedia'],
        }]) })
      }
      if (url.pathname.endsWith('/availability')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          slots: [{ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), timeZone: 'Europe/Warsaw' }],
        }) })
      }
      if (url.pathname.endsWith('/requests')) {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      }
      return route.continue()
    })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/umow-sie/${productId}`)
    await page.getByRole('button', { name: /Elżbieta Sokołowska/ }).click()
    await page.getByRole('button', { name: /\d{2}:\d{2}/ }).click()
    for (const [id, value] of Object.entries({
      'requester-first-name': 'Jan',
      'requester-last-name': 'Kowalski',
      'requester-email': 'jan@example.test',
      'requester-phone': '+48 600 000 000',
      'patient-first-name': 'Alicja',
      'patient-last-name': 'Kowalska',
      'patient-street': 'Leśna 1',
      'patient-postal-code': '50-001',
      'patient-city': 'Wrocław',
      'patient-country': 'PL',
    })) await page.locator(`#${id}`).fill(value)
    await page.locator('#booking-terms').click()
    await page.locator('#booking-privacy').click()
    await page.getByRole('button', { name: /Wyślij zgłoszenie|Send request/i }).click()

    await expect(page).toHaveURL(/\/umow-sie\/dziekujemy$/)
    await expect(page.getByRole('heading', { name: /Dziękujemy!|Thank you!/i })).toBeVisible()
    expect(page.url()).not.toContain('jan')
    expect(page.url()).not.toContain('alicja')
    expect(browserErrors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('public-booking-success-mobile.png'), fullPage: true })
  })
})
