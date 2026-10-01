/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { OnlineBookingProvenance } from '../components/OnlineBookingProvenance'
import type { PatientVisitAccess } from '../components/usePatientVisitAccess'

const mockUseQuery = jest.fn()

jest.mock('@tanstack/react-query', () => ({ useQuery: (...args: unknown[]) => mockUseQuery(...args) }))
jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) => params ? `${key}:${Object.values(params).join(':')}` : key,
}))

const access: PatientVisitAccess = {
  status: 'ready', canView: true, canManage: true, canCorrect: true, canSettle: true,
}

describe('online booking provenance', () => {
  beforeEach(() => { jest.clearAllMocks() })

  it('stays hidden for staff-created visits', () => {
    mockUseQuery.mockReturnValue({ data: { onlineBooking: null }, isLoading: false, error: null, refetch: jest.fn() })
    const { container } = render(<OnlineBookingProvenance visitId="11111111-1111-4111-8111-111111111111" access={access} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows online source, consent state, and delivery state without requester PII', () => {
    mockUseQuery.mockReturnValue({
      data: { onlineBooking: {
        submittedAt: '2026-10-01T10:00:00.000Z',
        termsAcceptedAt: '2026-10-01T10:00:00.000Z',
        privacyPolicyAcceptedAt: '2026-10-01T10:00:00.000Z',
        confirmationEmailSentAt: '2026-10-01T11:00:00.000Z',
      } },
      isLoading: false, error: null, refetch: jest.fn(),
    })
    render(<OnlineBookingProvenance visitId="11111111-1111-4111-8111-111111111111" access={access} />)
    expect(screen.getByText('patient.visits.onlineBooking.title')).toBeVisible()
    expect(screen.getByText('patient.visits.onlineBooking.termsAccepted')).toBeVisible()
    expect(screen.getByText('patient.visits.onlineBooking.privacyAccepted')).toBeVisible()
    expect(document.body.textContent).not.toContain('@')
  })

  it('offers a recoverable error state', () => {
    const refetch = jest.fn()
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false, error: new Error('offline'), refetch })
    render(<OnlineBookingProvenance visitId="11111111-1111-4111-8111-111111111111" access={access} />)
    fireEvent.click(screen.getByRole('button', { name: 'patient.common.retry' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
