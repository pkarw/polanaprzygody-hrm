/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { VisitPaymentSection } from '../components/VisitPaymentSection'
import type { PatientVisitItem } from '../types'
import type { PatientVisitAccess } from '../components/usePatientVisitAccess'

const apiCall = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const showConflict = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string) => key,
}))
jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  readApiResultOrThrow: (...args: unknown[]) => apiCall(...args),
}))
jest.mock('@open-mercato/ui/backend/conflicts', () => ({
  showRecordConflict: (...args: unknown[]) => showConflict(...args),
}))

const access: PatientVisitAccess = {
  status: 'ready',
  canView: true,
  canManage: true,
  canCorrect: true,
  canSettle: true,
}

const visit: PatientVisitItem = {
  id: '11111111-1111-4111-8111-111111111111',
  patientId: '22222222-2222-4222-8222-222222222222',
  patientName: 'Patient',
  teamMemberId: '33333333-3333-4333-8333-333333333333',
  teamMemberName: 'Therapist',
  resourceId: null,
  resourceName: null,
  startsAt: '2026-10-02T08:00:00.000Z',
  endsAt: '2026-10-02T09:00:00.000Z',
  timeZone: 'Europe/Warsaw',
  status: 'planned',
  confirmedAt: '2026-10-01T10:00:00.000Z',
  isConfirmed: true,
  confirmationApplicable: true,
  isSettled: false,
  settledAt: null,
  services: [{
    id: '44444444-4444-4444-8444-444444444444',
    productId: '55555555-5555-4555-8555-555555555555',
    title: 'Service',
    sku: 'SERVICE',
    isAvailable: true,
    position: 0,
  }],
  payment: {
    linkId: '66666666-6666-4666-8666-666666666666',
    slug: 'opaque-token',
    url: 'https://app.example.test/pay/opaque-token',
    status: 'pending',
    receivedAt: null,
    configurationError: false,
  },
  updatedAt: '2026-10-01T10:00:00.000Z',
}

describe('VisitPaymentSection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiCall.mockResolvedValue({
      ok: true,
      updatedAt: visit.updatedAt,
      paymentLink: null,
      paymentLinkError: null,
      paymentLinkEmailQueued: true,
      paymentLinkEmailError: null,
    })
  })

  it('shows semantic pending state and sends a versioned manual email request', async () => {
    const onSaved = jest.fn(async () => undefined)
    render(<VisitPaymentSection visit={visit} access={access} onSaved={onSaved} />)
    expect(screen.getByText('patient.visits.payment.status.pending')).toBeVisible()
    expect(screen.getByDisplayValue(visit.payment!.url!)).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: 'patient.visits.payment.sendEmail' }))
    await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(1))
    const [path, init] = apiCall.mock.calls[0] as unknown as [string, RequestInit]
    expect(path.endsWith('/payment-link/email')).toBe(true)
    expect(JSON.parse(String(init.body))).toEqual({ expectedUpdatedAt: visit.updatedAt })
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('renders an empty state and disables generation when the visit has no services', () => {
    render(
      <VisitPaymentSection
        visit={{ ...visit, services: [], payment: null }}
        access={access}
        onSaved={() => undefined}
      />,
    )
    expect(screen.getByText('patient.visits.payment.noServices')).toBeVisible()
    expect(screen.getByRole('button', { name: 'patient.visits.payment.generate' })).toBeDisabled()
  })
})
