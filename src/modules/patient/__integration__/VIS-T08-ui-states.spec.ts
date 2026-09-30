import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { login as browserLogin } from '@open-mercato/core/helpers/integration/auth'
import {
  createStaffTeamMemberFixture,
  deleteStaffEntityIfExists,
} from '@open-mercato/core/helpers/integration/staffFixtures'
import {
  callApiOk,
  cleanupPatient,
  cleanupVisit,
  createPatient,
  createVisit,
  login,
  readVisit,
  unique,
  visitAction,
  type CreatedPatient,
} from './helpers/api'

const FUTURE_START = '2099-05-10T10:00:00+02:00'
const FUTURE_END = '2099-05-10T10:45:00+02:00'

function patientRow(page: Page, name: string) {
  return page.getByRole('row').filter({ hasText: name })
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem('om-theme', value), theme)
  await page.emulateMedia({ colorScheme: theme })
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  if (process.env.PW_CAPTURE_SCREENSHOTS !== '1') return
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
}

test.describe('VIS-T08: visit browser surfaces and quality states', () => {
  test.beforeEach(async ({ page }) => {
    await browserLogin(page, 'admin')
  })

  test('renders list, guarded dialogs, conflict recovery, closed read-only, themes, and 360px', async ({ page, request }, testInfo) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let visitId: string | null = null
    try {
      patient = await createPatient(request, actor, {
        firstName: 'Testowa',
        lastName: unique('Wizyta'),
      })
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS browser clinician'),
      })
      const created = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: FUTURE_START,
        endsAt: FUTURE_END,
        timeZone: 'Europe/Warsaw',
        serviceProductIds: [],
      })
      visitId = created.id

      await setTheme(page, 'light')
      await page.goto('/backend/patient/visits')
      await expect(page.getByRole('heading', { level: 1, name: /Wizyty|Visits/i })).toBeVisible()
      await expect(page.getByText(/Testowa/).first()).toBeVisible()
      await expect(page.getByText(/Planowana|Planned/i).first()).toBeVisible()
      expect(await page.locator('body').innerText()).not.toContain(visitId)
      await attachScreenshot(page, testInfo, 'vis-2-list-light')

      await setTheme(page, 'dark')
      await page.goto(`/backend/patient/visits/${visitId}`)
      const lifecycle = page.locator('[data-visit-lifecycle-actions]')
      await expect(lifecycle).toBeVisible()
      await expect(page.getByRole('button', { name: /Odwołaj wizytę|Cancel visit/i })).toBeVisible()
      await page.getByRole('button', { name: /Odwołaj wizytę|Cancel visit/i }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      const reason = dialog.getByLabel(/Powód|Reason/i)
      await reason.fill('Browser conflict reason remains visible')
      await expect(reason).toBeFocused()
      await attachScreenshot(page, testInfo, 'vis-2-action-dialog-dark')

      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: created.updatedAt,
        description: 'Concurrent browser-tab update',
      })
      await page.keyboard.press('Control+Enter')
      await expect(page.locator('[data-testid="record-conflict-banner"]')).toBeVisible()
      await expect(reason).toHaveValue('Browser conflict reason remains visible')
      await expect(dialog).toBeVisible()
      await attachScreenshot(page, testInfo, 'vis-2-conflict-reason-dark')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      const afterConcurrentUpdate = await readVisit(request, actor, visitId)
      const cancelled = await visitAction(request, actor, visitId, 'status', {
        status: 'cancelled',
        reason: 'Browser read-only proof',
        expectedUpdatedAt: afterConcurrentUpdate?.updatedAt,
      })
      await page.reload()
      await expect(page.getByText(/zamknięta.*tylko do odczytu|closed.*read.only/i)).toBeVisible()
      await expect(page.getByRole('button', { name: /Zapisz wizytę|Save visit/i })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Otwórz ponownie|Reopen/i })).toBeVisible()
      await expect(page.getByRole('button', { name: /Oznacz jako rozliczoną|Mark as settled/i })).toBeVisible()
      await attachScreenshot(page, testInfo, 'vis-2-closed-read-only-dark')

      await visitAction(request, actor, visitId, 'status', {
        status: 'planned',
        reason: 'Restore narrow planned proof',
        expectedUpdatedAt: cancelled.updatedAt,
      })
      await page.setViewportSize({ width: 360, height: 900 })
      await setTheme(page, 'light')
      await page.reload()
      await expect(lifecycle).toBeVisible()
      await expect(page.locator('[data-lifecycle-before-start]')).toBeVisible()
      await expect(page.getByRole('button', { name: /Zakończ|Complete/i })).toBeDisabled()
      await expect(page.getByRole('button', { name: /Oznacz nieobecność|No.show/i })).toBeDisabled()
      await expect(page.getByRole('button', { name: /Potwierdź|Confirm/i })).toBeVisible()
      const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(horizontalOverflow).toBeLessThanOrEqual(1)
      await attachScreenshot(page, testInfo, 'vis-2-actions-360-light')
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })

  test('renders create validation and the patient visit tab without losing entered values', async ({ page, request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    try {
      const lastName = unique('VIS create patient')
      patient = await createPatient(request, actor, { firstName: 'Browser', lastName })

      await page.goto(`/backend/patient/visits/create?patientId=${encodeURIComponent(patient.id)}`)
      await expect(page.getByRole('heading', { level: 1, name: /Zaplanuj wizytę|Schedule visit/i })).toBeVisible()
      await expect(page.getByText(/Pacjent i personel|Patient and staff/i)).toBeVisible()
      await expect(page.getByText(/Termin|Schedule/i)).toBeVisible()
      await expect(page.getByLabel(/Początek|Starts/i)).toBeVisible()
      await expect(page.getByLabel(/Strefa czasowa|Time zone/i)).toBeVisible()

      const notes = page.getByLabel(/Notatka organizacyjna|Organisational notes/i)
      await notes.fill('VIS-T08 value survives client validation')
      const save = page.getByRole('button', { name: /Zapisz wizytę|Save visit/i })
      await save.click()

      const firstInvalidField = page.locator('form [aria-invalid="true"]').first()
      await expect(firstInvalidField).toBeVisible()
      await expect(firstInvalidField).toBeFocused()
      await expect(notes).toHaveValue('VIS-T08 value survives client validation')
      await expect(page).toHaveURL(new RegExp(`/backend/patient/visits/create\\?patientId=${patient.id}`))

      await page.goto(`/backend/patient/patients/${patient.id}?tab=visits`)
      const visitsTab = page.getByRole('tab', { name: /Wizyty|Visits/i })
      await expect(visitsTab).toHaveAttribute('data-state', 'active')
      await expect(page.getByRole('heading', { level: 2, name: /Wizyty|Visits/i })).toBeVisible()
      await expect(page.getByRole('link', { name: /Zaplanuj wizytę|Schedule visit/i })).toHaveAttribute(
        'href',
        `/backend/patient/visits/create?patientId=${patient.id}`,
      )
    } finally {
      await cleanupPatient(request, actor, patient?.id ?? null)
    }
  })

  test('shows the nearest planned visit and explicit empty next-visit states on the patient list', async ({ page, request }) => {
    const actor = await login(request)
    let teamMemberId: string | null = null
    const patients: CreatedPatient[] = []
    const visitIds: string[] = []
    let cancelledVisitId: string | null = null
    let cancelledVisitUpdatedAt: string | null = null
    const names = {
      future: unique('VIS future'),
      empty: unique('VIS empty'),
      past: unique('VIS past'),
      cancelled: unique('VIS cancelled'),
    }
    try {
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS next visit clinician'),
      })
      const futurePatient = await createPatient(request, actor, { firstName: 'Browser', lastName: names.future })
      const emptyPatient = await createPatient(request, actor, { firstName: 'Browser', lastName: names.empty })
      const pastPatient = await createPatient(request, actor, { firstName: 'Browser', lastName: names.past })
      const cancelledPatient = await createPatient(request, actor, { firstName: 'Browser', lastName: names.cancelled })
      patients.push(futurePatient, emptyPatient, pastPatient, cancelledPatient)

      const futureVisit = await createVisit(request, actor, {
        patientId: futurePatient.id,
        teamMemberId,
        startsAt: FUTURE_START,
        endsAt: FUTURE_END,
        timeZone: 'Europe/Warsaw',
      })
      visitIds.push(futureVisit.id)
      const pastVisit = await createVisit(request, actor, {
        patientId: pastPatient.id,
        teamMemberId,
        startsAt: '2020-05-10T10:00:00+02:00',
        endsAt: '2020-05-10T10:45:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      visitIds.push(pastVisit.id)
      const cancelledVisit = await createVisit(request, actor, {
        patientId: cancelledPatient.id,
        teamMemberId,
        startsAt: '2098-05-10T10:00:00+02:00',
        endsAt: '2098-05-10T10:45:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      cancelledVisitId = cancelledVisit.id
      visitIds.push(cancelledVisit.id)
      const cancelled = await visitAction(request, actor, cancelledVisit.id, 'status', {
        status: 'cancelled',
        reason: 'VIS-T08 cancelled visit must not become nextVisit',
        expectedUpdatedAt: cancelledVisit.updatedAt,
      })
      cancelledVisitUpdatedAt = cancelled.updatedAt

      await page.goto('/backend/patient/patients')
      await expect(page.getByRole('columnheader', { name: /Najbliższa wizyta|Next visit/i })).toBeVisible()
      await expect(patientRow(page, names.future)).toContainText('2099')
      await expect(patientRow(page, names.future)).toContainText(/Niepotwierdzona|Unconfirmed/i)
      await expect(patientRow(page, names.empty)).toContainText(/Brak zaplanowanej wizyty|No visit planned/i)
      await expect(patientRow(page, names.past)).toContainText(/Brak zaplanowanej wizyty|No visit planned/i)
      await expect(patientRow(page, names.cancelled)).toContainText(/Brak zaplanowanej wizyty|No visit planned/i)
    } finally {
      if (cancelledVisitId && cancelledVisitUpdatedAt) {
        const reopened = await visitAction(request, actor, cancelledVisitId, 'status', {
          status: 'planned',
          reason: 'VIS-T08 fixture cleanup',
          expectedUpdatedAt: cancelledVisitUpdatedAt,
        }).catch(() => null)
        if (reopened) cancelledVisitUpdatedAt = reopened.updatedAt
      }
      for (const visitId of visitIds) await cleanupVisit(request, actor, visitId)
      for (const patient of patients.reverse()) await cleanupPatient(request, actor, patient.id)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })

  test('fails closed by hiding nextVisit when the visit feature is not granted', async ({ page }) => {
    const featureCheck = page.waitForResponse((response) =>
      response.url().includes('/api/auth/feature-check')
      && response.request().postData()?.includes('patient.visits.view') === true,
    )
    await page.route('**/api/auth/feature-check', async (route) => {
      const request = route.request()
      if (request.method() !== 'POST' || !request.postData()?.includes('patient.visits.view')) {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ granted: [] }),
      })
    })

    await page.goto('/backend/patient/patients')
    await featureCheck
    await expect(page.getByRole('heading', { level: 1, name: /Pacjenci|Patients/i })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /Najbliższa wizyta|Next visit/i })).toHaveCount(0)
  })

  test('renders visit list loading, empty, error, and retry states', async ({ page }) => {
    let mode: 'loading' | 'empty' | 'error' = 'loading'
    let releaseLoading!: () => void
    const loadingGate = new Promise<void>((resolve) => { releaseLoading = resolve })

    await page.route(/\/api\/patient\/visits(?:\?|$)/, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      if (mode === 'loading') await loadingGate
      if (mode === 'error') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'VIS-T08 synthetic list failure' }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 }),
      })
    })

    await page.goto('/backend/patient/visits')
    await expect(page.getByText(/Ładowanie danych|Loading data/i)).toBeVisible()
    mode = 'empty'
    releaseLoading()
    await expect(page.getByText(/Brak wizyt|No visits/i)).toBeVisible()
    await expect(page.getByRole('link', { name: /Zaplanuj wizytę|Schedule visit/i })).toBeVisible()

    mode = 'error'
    await page.reload()
    await expect(page.getByText(/Nie udało się wczytać tej sekcji|Could not load this section/i)).toBeVisible()
    const retry = page.getByRole('button', { name: /Spróbuj ponownie|Try again/i })
    await expect(retry).toBeVisible()

    mode = 'empty'
    await retry.click()
    await expect(page.getByText(/Brak wizyt|No visits/i)).toBeVisible()
  })
})
