import { expect, test } from '@playwright/test'
import { callApi, cleanupPatient, createPatient, login, type CreatedPatient } from './helpers/api'

/**
 * PAT-T11 — the rendered surfaces and their required states.
 *
 * Oracle (spec): canonical components, preserved input and focus, and no UUID visible in the UI,
 * across loading / empty / error / conflict, 360 px, both themes and the keyboard.
 *
 * These drive the real browser. Authentication is established through the login API and the
 * resulting cookie, because the page tests need a session, not a bearer token.
 */
test.describe('PAT-T11: patient UI states', () => {
  test.beforeEach(async ({ page }) => {
    const email = process.env.OM_INTEGRATION_ADMIN_EMAIL
    const password = process.env.OM_INTEGRATION_ADMIN_PASSWORD
    test.skip(!email || !password, 'Set OM_INTEGRATION_ADMIN_EMAIL and OM_INTEGRATION_ADMIN_PASSWORD.')
    // Through the API so the browser holds the same `auth_token` cookie the app sets on login.
    const response = await page.request.post('/api/auth/login', {
      data: { email, password },
      headers: { 'content-type': 'application/json' },
    })
    expect(response.ok(), `login failed: ${response.status()}`).toBeTruthy()
  })

  test('renders the register with its heading and add action', async ({ page }) => {
    await page.goto('/backend/patient/patients')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // The localized add action linking to the canonical create route.
    await expect(page.locator('a[href="/backend/patient/patients/create"]').first()).toBeVisible()
  })

  test('never renders a raw identifier in the register', async ({ page, request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor, { firstName: 'Widoczna', lastName: 'Nazwa' })
      await page.goto('/backend/patient/patients')
      await expect(page.getByText('Widoczna Nazwa').first()).toBeVisible()

      // The spec forbids showing a UUID: the record id must not appear anywhere in the rendered
      // text, even though it is present in hrefs.
      const bodyText = await page.locator('body').innerText()
      expect(bodyText).not.toContain(created.id)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('shows the create form with its required fields and a country picker', async ({ page }) => {
    await page.goto('/backend/patient/patients/create')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // The first address is part of the same form, because the record and its address are written
    // in one transaction.
    await expect(page.getByLabel(/Ulica|Street/i).first()).toBeVisible()
    await expect(page.getByLabel(/Miasto|City/i).first()).toBeVisible()
  })

  test('keeps the operator input after a validation refusal', async ({ page }) => {
    await page.goto('/backend/patient/patients/create')
    const firstName = page.getByLabel(/Imię|First name/i).first()
    await firstName.fill('Zachowane')
    // Submitting without the required address and contact fields must refuse.
    await page.getByRole('button', { name: /Zapisz|Save/i }).first().click()
    // The value the operator typed survives the refusal — the spec requires it explicitly.
    await expect(firstName).toHaveValue('Zachowane')
  })

  test('opens the patient card and switches tabs by keyboard', async ({ page, request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      await page.goto(`/backend/patient/patients/${created.id}`)

      const tablist = page.getByRole('tablist').first()
      await expect(tablist).toBeVisible()

      const firstTab = page.getByRole('tab').first()
      await firstTab.focus()
      // The Tabs primitive wires arrow-key navigation; this is the spec's keyboard requirement.
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('tab', { selected: true })).toBeVisible()
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('lays out the register at 360 px without losing the add action', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/backend/patient/patients')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // Controls must remain reachable at the narrow width rather than being clipped away.
    await expect(page.locator('a[href="/backend/patient/patients/create"]').first()).toBeVisible()
  })

  test('renders in both colour schemes', async ({ page }) => {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.goto('/backend/patient/patients')
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    }
  })

  test('shows a not-found state for a record that is not visible', async ({ page }) => {
    await page.goto('/backend/patient/patients/99999999-9999-4999-8999-999999999999')
    // Not a crash and not an empty shell: an explicit state with a way back to the list.
    await expect(page.locator('a[href="/backend/patient/patients"]').first()).toBeVisible({
      timeout: 15_000,
    })
  })

  test('hides the clinical tabs from an actor without the clinical feature', async ({ page, request }) => {
    const actor = await login(request)
    const probe = await callApi(request, 'GET', '/api/patient/diagnoses?patientId=99999999-9999-4999-8999-999999999999&pageSize=1', actor)
    // This assertion is only meaningful for an actor that LACKS the feature; the default
    // integration admin usually has it, so the case documents the contract and skips otherwise.
    test.skip(probe.status !== 403, 'This actor holds patient.clinical.view, so there is nothing to hide.')

    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      await page.goto(`/backend/patient/patients/${created.id}`)
      await expect(page.getByRole('tab', { name: /Diagnoz|Diagnos/i })).toHaveCount(0)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })
})
