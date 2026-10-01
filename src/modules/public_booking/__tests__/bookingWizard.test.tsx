/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { BookingWizard } from '../frontend/components/BookingWizard'

const fetchMock = jest.fn<typeof fetch>()
const pushMock = jest.fn()
const productId = '33333333-3333-4333-8333-333333333333'
const therapistId = '44444444-4444-4444-8444-444444444444'

function response(payload: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response
}

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) => {
    const suffix = params ? `:${Object.values(params).join(':')}` : ''
    return `${key}${suffix}`
  },
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

jest.mock('../frontend/components/PublicLayout', () => ({
  PublicLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function basePayload(path: string): Response | null {
  if (path === '/api/public/booking/services') {
    return response([{
      id: productId,
      title: 'Diagnoza logopedyczna',
      description: 'Opis',
      durationMinutes: 60,
      category: 'Diagnoza',
      price: { currency: 'PLN', amount: '249', isPromotion: false },
    }])
  }
  if (path.endsWith('/therapists')) {
    return response([{
      id: therapistId,
      displayName: 'Anna Nowicka',
      shortBio: 'Neurologopedka',
      specializations: ['Logopedia'],
    }])
  }
  return null
}

describe('public booking therapist and slot selection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = fetchMock
    Object.defineProperty(global.crypto, 'randomUUID', {
      configurable: true,
      value: jest.fn(() => '55555555-5555-4555-8555-555555555555'),
    })
    window.requestAnimationFrame = (callback) => {
      callback(0)
      return 1
    }
  })

  it('submits complete consented details once and navigates without PII in the URL', async () => {
    const start = new Date(Date.now() + 48 * 60 * 60_000)
    start.setMinutes(0, 0, 0)
    const end = new Date(start.getTime() + 60 * 60_000)
    fetchMock.mockImplementation(async (input) => {
      const path = String(input)
      const base = basePayload(path)
      if (base) return base
      if (path.startsWith('/api/public/booking/availability?')) {
        return response({ slots: [{ startsAt: start.toISOString(), endsAt: end.toISOString(), timeZone: 'Europe/Warsaw' }] })
      }
      if (path === '/api/public/booking/requests') return response({ ok: true }, 201)
      return response({ error: 'not found' }, 404)
    })

    render(<BookingWizard productId={productId} />)
    fireEvent.click(await screen.findByRole('button', { name: /Anna Nowicka/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 2_000 })
    fireEvent.click(await screen.findByRole('button', { name: /\d{2}:\d{2}/ }))
    const values: Record<string, string> = {
      'requester-first-name': 'Jan', 'requester-last-name': 'Kowalski', 'requester-email': 'jan@example.com',
      'requester-phone': '+48 600 000 000', 'patient-first-name': 'Ala', 'patient-last-name': 'Kowalska',
      'patient-street': 'Leśna 1', 'patient-postal-code': '50-001', 'patient-city': 'Wrocław', 'patient-country': 'PL',
    }
    for (const [id, value] of Object.entries(values)) {
      fireEvent.change(document.getElementById(id)!, { target: { value } })
    }
    fireEvent.click(document.getElementById('booking-terms')!)
    fireEvent.click(document.getElementById('booking-privacy')!)
    fireEvent.click(screen.getByRole('button', { name: 'public_booking.booking.form.submit' }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/umow-sie/dziekujemy'))
    const requestCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/public/booking/requests')
    expect(requestCall?.[1]?.headers).toMatchObject({ 'idempotency-key': '55555555-5555-4555-8555-555555555555' })
    expect(JSON.parse(String(requestCall?.[1]?.body))).toMatchObject({
      requester: { firstName: 'Jan', email: 'jan@example.com' },
      patient: { firstName: 'Ala', address: { city: 'Wrocław', country: 'PL' } },
      consents: { terms: true, privacyPolicy: true },
    })
  })

  it('preserves intake values and forces a fresh slot choice after a conflict', async () => {
    const start = new Date(Date.now() + 48 * 60 * 60_000)
    start.setMinutes(0, 0, 0)
    const end = new Date(start.getTime() + 60 * 60_000)
    fetchMock.mockImplementation(async (input) => {
      const path = String(input)
      const base = basePayload(path)
      if (base) return base
      if (path.startsWith('/api/public/booking/availability?')) {
        return response({ slots: [{ startsAt: start.toISOString(), endsAt: end.toISOString(), timeZone: 'Europe/Warsaw' }] })
      }
      if (path === '/api/public/booking/requests') return response({ error: 'conflict' }, 409)
      return response({ error: 'not found' }, 404)
    })

    render(<BookingWizard productId={productId} />)
    fireEvent.click(await screen.findByRole('button', { name: /Anna Nowicka/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 2_000 })
    fireEvent.click(await screen.findByRole('button', { name: /\d{2}:\d{2}/ }))
    const required = ['requester-first-name', 'requester-last-name', 'requester-phone', 'patient-first-name', 'patient-last-name', 'patient-street', 'patient-postal-code', 'patient-city']
    required.forEach((id) => fireEvent.change(document.getElementById(id)!, { target: { value: id === 'requester-first-name' ? 'Jan' : 'x' } }))
    fireEvent.click(document.getElementById('booking-terms')!)
    fireEvent.click(document.getElementById('booking-privacy')!)
    fireEvent.click(screen.getByRole('button', { name: 'public_booking.booking.form.submit' }))

    expect(await screen.findByText('public_booking.booking.errors.409')).toBeVisible()
    expect(screen.queryByText('public_booking.booking.form.title')).not.toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5), { timeout: 2_000 })
    fireEvent.click(await screen.findByRole('button', { name: /\d{2}:\d{2}/ }))
    expect(document.getElementById('requester-first-name')).toHaveValue('Jan')
  })

  it('loads assigned therapists, debounces availability and selects an opaque room-free slot', async () => {
    const start = new Date(Date.now() + 48 * 60 * 60_000)
    start.setMinutes(0, 0, 0)
    const end = new Date(start.getTime() + 60 * 60_000)
    fetchMock.mockImplementation(async (input) => {
      const path = String(input)
      const base = basePayload(path)
      if (base) return base
      if (path.startsWith('/api/public/booking/availability?')) {
        return response({ slots: [{ startsAt: start.toISOString(), endsAt: end.toISOString(), timeZone: 'Europe/Warsaw' }] })
      }
      return response({ error: 'not found' }, 404)
    })

    render(<BookingWizard productId={productId} />)
    expect(await screen.findByText('Anna Nowicka')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Anna Nowicka/ }))
    expect(screen.getByText('public_booking.booking.loadingAvailability')).toBeVisible()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 2_000 })
    const timeButton = await screen.findByRole('button', { name: /\d{2}:\d{2}/ })
    fireEvent.click(timeButton)
    expect(screen.getByText('public_booking.booking.slotSelected')).toBeVisible()
    expect(document.body.textContent).not.toContain('room')
  })

  it('shows a phone recovery state and no times when planner availability degrades', async () => {
    fetchMock.mockImplementation(async (input) => {
      const path = String(input)
      const base = basePayload(path)
      if (base) return base
      return response({ slots: [], degraded: true })
    })

    render(<BookingWizard productId={productId} />)
    fireEvent.click(await screen.findByRole('button', { name: /Anna Nowicka/ }))
    expect(await screen.findByText('public_booking.booking.degradedTitle', undefined, { timeout: 2_000 })).toBeVisible()
    expect(screen.getByRole('link', { name: /790 512 258/ })).toHaveAttribute('href', 'tel:+48790512258')
    expect(screen.queryByText('public_booking.booking.slotSelected')).not.toBeInTheDocument()
  })
})
