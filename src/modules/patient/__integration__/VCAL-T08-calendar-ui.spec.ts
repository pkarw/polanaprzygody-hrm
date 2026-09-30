import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { login as browserLogin } from '@open-mercato/core/helpers/integration/auth'
import {
  createStaffTeamMemberFixture,
  deleteStaffEntityIfExists,
} from '@open-mercato/core/helpers/integration/staffFixtures'
import {
  cleanupPatient,
  cleanupVisit,
  createPatient,
  createVisit,
  login,
  unique,
  type CreatedPatient,
} from './helpers/api'

const FROM = '2099-05-10T00:00:00+02:00'
const TO = '2099-05-17T00:00:00+02:00'

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

function calendarUrl(filters: Record<string, string> = {}): string {
  return `/backend/patient/visits/calendar?${new URLSearchParams({
    from: FROM,
    to: TO,
    view: 'week',
    timeZone: 'Europe/Warsaw',
    ...filters,
  }).toString()}`
}

test.describe('VCAL-T08: visit calendar browser workflow', () => {
  test.describe.configure({ timeout: 60_000 })

  test.beforeEach(async ({ page }) => {
    await browserLogin(page, 'admin')
  })

  test('navigates day/week/month/agenda and opens create/edit dialogs with keyboard and responsive themes', async ({ page, request }, testInfo) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let visitId: string | null = null
    try {
      const lastName = unique('VCAL Browser')
      patient = await createPatient(request, actor, { firstName: 'Calendar', lastName })
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VCAL browser clinician'),
      })
      const visit = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-05-10T10:00:00+02:00',
        endsAt: '2099-05-10T10:45:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      visitId = visit.id

      await setTheme(page, 'light')
      await page.goto(calendarUrl({ teamMemberId }))
      await expect(page.getByRole('heading', { level: 1, name: /Kalendarz wizyt|Visit calendar/i })).toBeVisible()
      const views = page.getByRole('radiogroup', { name: /Widok harmonogramu|Schedule view/i })
      await expect(views).toBeVisible()
      await expect(views.getByRole('radio', { name: /Tydzień|Week/i })).toHaveAttribute('data-state', 'checked')
      await expect(page.getByText(lastName).first()).toBeVisible()
      expect(await page.locator('body').innerText()).not.toContain(visitId)
      await attachScreenshot(page, testInfo, 'vcal-2-week-light')

      for (const view of [
        { name: /Dzień|Day/i, query: 'day' },
        { name: /Miesiąc|Month/i, query: 'month' },
        { name: /Agenda/i, query: 'agenda' },
        { name: /Tydzień|Week/i, query: 'week' },
      ]) {
        await views.getByRole('radio', { name: view.name }).click()
        await expect(views.getByRole('radio', { name: view.name })).toHaveAttribute('data-state', 'checked')
        await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe(view.query)
      }

      await page.goto(calendarUrl({ teamMemberId }))
      await expect(page.getByText(lastName).first()).toBeVisible()
      await page.getByRole('button', { name: new RegExp(lastName) }).click()
      const editDialog = page.getByRole('dialog')
      await expect(editDialog.getByRole('heading', { name: /Wizyta|Visit/i })).toBeVisible()
      await expect(editDialog.getByRole('combobox').first()).toBeDisabled()
      await editDialog.getByRole('button', { name: /Usuń|Delete/i }).click()
      const deleteConfirmation = page.getByRole('alertdialog')
      await expect(deleteConfirmation.getByText(/Usunąć tę wizytę|Delete this visit/i)).toBeVisible()
      await deleteConfirmation.getByRole('button', { name: /Potwierdź|Confirm/i }).click()
      await expect(editDialog).toBeHidden()
      visitId = null

      const selectableSlot = page.locator('.rbc-day-slot .rbc-time-slot').first()
      await expect(selectableSlot).toBeVisible()
      await selectableSlot.click({ position: { x: 8, y: 8 }, force: true, timeout: 5_000 })
      const createDialog = page.getByRole('dialog')
      await expect(createDialog.getByRole('heading', { name: /Zaplanuj wizytę|Schedule visit/i })).toBeVisible()
      await expect(createDialog.getByText(/Sprawdzanie dostępności|Checking availability|Termin jest dostępny|The selected time is available|Informacja o grafiku|Schedule information/i)).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(createDialog).toBeHidden()

      await page.setViewportSize({ width: 360, height: 900 })
      await setTheme(page, 'dark')
      await page.reload()
      await expect(page.getByRole('heading', { level: 1, name: /Kalendarz wizyt|Visit calendar/i })).toBeVisible()
      const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(horizontalOverflow).toBeLessThanOrEqual(1)
      await page.getByRole('button', { name: /Zaplanuj wizytę|Schedule visit/i }).first().focus()
      await expect(page.getByRole('button', { name: /Zaplanuj wizytę|Schedule visit/i }).first()).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog')).toBeVisible()
      await attachScreenshot(page, testInfo, 'vcal-2-create-360-dark')
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })

  test('surfaces degradation, warning override, blocking denial, and calendar retry states', async ({ page, request }, testInfo) => {
    const actor = await login(request)
    let teamMemberId: string | null = null
    let conflictMode: 'warning' | 'blocking' = 'warning'
    try {
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VCAL quality-state clinician'),
      })
      await page.route('**/api/patient/visits/calendar?**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [],
            lanes: [{
              subjectType: 'member',
              subjectId: teamMemberId,
              subjectName: 'Quality-state clinician',
              hasSchedule: false,
              unknown: true,
            windows: [{
              id: 'member-lane-availability',
              kind: 'availability',
              from: '2099-05-10T08:00:00+02:00',
              to: '2099-05-10T16:00:00+02:00',
            }, {
              id: 'member-lane-exception',
              kind: 'exception',
              from: '2099-05-10T12:00:00+02:00',
              to: '2099-05-10T12:30:00+02:00',
            }],
            }],
            degraded: [{
              code: 'availability_unknown',
              subjectType: 'member',
              subjectId: teamMemberId,
              subjectName: 'Quality-state clinician',
            }],
            range: { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() },
          }),
        })
      })
      await page.route('**/api/patient/visits/availability-check?**', async (route) => {
        const blocking = conflictMode === 'blocking'
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            conflicts: [{
              code: blocking ? 'resource_inactive' : 'member_double_booked',
              severity: blocking ? 'blocking' : 'warning',
              signature: blocking ? 'blocking-signature' : 'warning-signature',
              subjectType: blocking ? 'resource' : 'member',
              subjectId: teamMemberId,
              subjectName: 'Quality-state clinician',
            }],
            checkedAt: new Date().toISOString(),
            degraded: [],
          }),
        })
      })

      await setTheme(page, 'dark')
      await page.goto(calendarUrl({
        teamMemberId,
        from: '2099-05-01T00:00:00+02:00',
        to: '2099-07-04T00:00:00+02:00',
      }))
      await expect(page.getByText(/Zakres kalendarza jest za szeroki|Calendar range is too wide/i)).toBeVisible()
      await page.getByRole('button', { name: /Pokaż jeden miesiąc|Show one month/i }).click()
      await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('month')
      await expect(page.getByText(/Zakres kalendarza jest za szeroki|Calendar range is too wide/i)).toBeHidden()

      await page.goto(calendarUrl({ teamMemberId }))
      await expect(page.getByText(/Część dostępności jest nieznana|Some availability is unknown/i)).toBeVisible()
      await expect(page.getByText(/Brak grafiku dostępności|No availability schedule/i)).toBeVisible()
      await expect(page.locator('.schedule-event-availability, .schedule-event-exception')).toHaveCount(0)
      const laneSummary = page.locator('[data-visit-availability-lanes]')
      await expect(laneSummary).toContainText('Quality-state clinician')
      await expect(laneSummary.getByRole('button')).toHaveCount(0)
      await attachScreenshot(page, testInfo, 'vcal-2-degraded-dark')

      await page.getByRole('button', { name: /Zaplanuj wizytę|Schedule visit/i }).first().click()
      let dialog = page.getByRole('dialog')
      await expect(dialog.getByText(/Ostrzeżenia grafiku|Scheduling warnings/i)).toBeVisible()
      await dialog.getByRole('button', { name: /Zapisz mimo ostrzeżeń|Save despite warnings/i }).click()
      const overrideDialog = page.getByRole('dialog', { name: /Potwierdź ostrzeżenia grafiku|Confirm scheduling warnings/i })
      const reason = overrideDialog.getByLabel(/Powód nadpisania|Override reason/i)
      await expect(reason).toBeFocused()
      await reason.fill('VCAL-T08 browser override reason')
      await dialog.locator('form').evaluate((form) => {
        const visitForm = form as HTMLFormElement
        const original = visitForm.requestSubmit.bind(visitForm)
        ;(window as typeof window & { __visitOuterSubmits?: number }).__visitOuterSubmits = 0
        visitForm.requestSubmit = (submitter?: HTMLElement | null) => {
          ;(window as typeof window & { __visitOuterSubmits?: number }).__visitOuterSubmits =
            ((window as typeof window & { __visitOuterSubmits?: number }).__visitOuterSubmits ?? 0) + 1
          original(submitter)
        }
      })
      await reason.press('Control+Enter')
      await expect(overrideDialog).toBeHidden()
      await expect.poll(() => page.evaluate(() => (
        window as typeof window & { __visitOuterSubmits?: number }
      ).__visitOuterSubmits ?? 0)).toBe(0)
      await attachScreenshot(page, testInfo, 'vcal-2-warning-override-dark')
      await page.keyboard.press('Escape')

      conflictMode = 'blocking'
      await setTheme(page, 'light')
      await page.reload()
      await page.getByRole('button', { name: /Zaplanuj wizytę|Schedule visit/i }).first().click()
      dialog = page.getByRole('dialog')
      await expect(dialog.getByText(/Nie można zapisać tej wizyty|This visit cannot be saved/i)).toBeVisible()
      await expect(dialog.getByRole('button', { name: /Zapisz mimo ostrzeżeń|Save despite warnings/i })).toHaveCount(0)
      await attachScreenshot(page, testInfo, 'vcal-2-blocking-light')
      await page.keyboard.press('Escape')

      await page.unroute('**/api/patient/visits/calendar?**')
      await page.route('**/api/patient/visits/calendar?**', async (route) => {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary_failure' }) })
      })
      await page.reload()
      await expect(page.getByRole('button', { name: /Ponów|Try again|Retry/i })).toBeVisible()
    } finally {
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })
})
