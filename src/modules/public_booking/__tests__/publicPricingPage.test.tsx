/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { PricingPage } from '../frontend/components/PricingPage'

const fetchMock = jest.fn<typeof fetch>()

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response
}

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) => (
    params?.minutes ? `${key}:${String(params.minutes)}` : key
  ),
}))

jest.mock('../frontend/components/PublicLayout', () => ({
  PublicLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('public pricing page', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = fetchMock
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('announces loading and renders live catalogue pricing with a booking link', async () => {
    fetchMock.mockResolvedValue(response([{
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Diagnoza logopedyczna',
      description: 'Opis usługi',
      durationMinutes: 60,
      category: 'Diagnoza',
      price: { currency: 'PLN', amount: '249.00', wasAmount: '300.00', isPromotion: true },
    }]))

    render(<PricingPage />)
    expect(screen.getByText('public_booking.pricing.loading')).toBeVisible()
    expect(await screen.findByText('Diagnoza logopedyczna')).toBeVisible()
    expect(screen.getByText(/249,00/)).toBeVisible()
    expect(screen.getByText(/300,00/)).toHaveClass('line-through')
    expect(screen.getByRole('link', { name: /public_booking.site.book/ }))
      .toHaveAttribute('href', '/umow-sie/33333333-3333-4333-8333-333333333333')
  })

  it('surfaces a retryable error without replacing it with an empty state', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: 'down' }, 503))
      .mockResolvedValueOnce(response([]))

    render(<PricingPage />)
    expect(await screen.findByText('public_booking.pricing.errorTitle')).toBeVisible()
    expect(screen.queryByText('public_booking.pricing.emptyTitle')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /public_booking.common.retry/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('public_booking.pricing.emptyTitle')).toBeVisible()
  })
})
