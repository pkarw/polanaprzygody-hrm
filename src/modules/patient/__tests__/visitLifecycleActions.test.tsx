/** @jest-environment jsdom */
import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { PatientVisitItem } from '../types'
import type { PatientVisitAccess } from '../components/usePatientVisitAccess'
import { VisitLifecycleActions } from '../components/VisitLifecycleActions'

const mockApiCall = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockShowConflict = jest.fn()
const mockRunMutation = jest.fn(async (input: { operation: () => Promise<unknown> }) => (
  await input.operation()
))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string) => key,
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  readApiResultOrThrow: (...args: unknown[]) => mockApiCall(...args),
}))

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: mockRunMutation,
    retryLastMutation: jest.fn(async () => false),
  }),
}))

jest.mock('@open-mercato/ui/backend/conflicts', () => ({
  showRecordConflict: (...args: unknown[]) => mockShowConflict(...args),
}))

const visit: PatientVisitItem = {
  id: '55555555-5555-4555-8555-555555555555',
  patientId: '44444444-4444-4444-8444-444444444444',
  patientName: 'Test Patient',
  teamMemberId: '66666666-6666-4666-8666-666666666666',
  teamMemberName: 'Test Clinician',
  resourceId: null,
  resourceName: null,
  startsAt: '2020-01-01T09:00:00.000Z',
  endsAt: null,
  timeZone: 'UTC',
  description: null,
  status: 'planned',
  confirmedAt: null,
  isConfirmed: false,
  confirmationApplicable: true,
  isSettled: false,
  settledAt: null,
  services: [],
  updatedAt: '2026-09-30T09:00:00.000Z',
}

const access: PatientVisitAccess = {
  status: 'ready',
  canView: true,
  canManage: true,
  canCorrect: true,
  canSettle: true,
}

function successResult(overrides: Partial<PatientVisitItem> = {}) {
  return {
    ok: true,
    id: visit.id,
    status: overrides.status ?? visit.status,
    confirmedAt: overrides.confirmedAt ?? null,
    isConfirmed: overrides.isConfirmed ?? false,
    confirmationApplicable: true,
    isSettled: overrides.isSettled ?? false,
    settledAt: overrides.settledAt ?? null,
    updatedAt: '2026-09-30T09:01:00.000Z',
  }
}

describe('VisitLifecycleActions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockApiCall.mockResolvedValue(successResult())
  })

  it('opens a consequence dialog before confirmation and sends the current version once applied', async () => {
    const onSaved = jest.fn(async () => undefined)
    render(<VisitLifecycleActions visit={visit} access={access} onSaved={onSaved} />)

    fireEvent.click(screen.getByRole('button', { name: 'patient.visits.lifecycle.confirm' }))
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByText('patient.visits.lifecycle.confirmTitle')).toBeVisible()
    expect(mockApiCall).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'patient.visits.lifecycle.apply' }))
    await waitFor(() => expect(mockApiCall).toHaveBeenCalledTimes(1))
    const [path, init] = mockApiCall.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toContain('/confirmation')
    expect(JSON.parse(String(init.body))).toEqual({
      confirmed: true,
      expectedUpdatedAt: visit.updatedAt,
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('keeps a required reason in the open dialog across a version conflict and refresh', async () => {
    const conflict = Object.assign(new Error('changed'), {
      status: 409,
      code: 'version_conflict',
      currentUpdatedAt: '2026-09-30T09:02:00.000Z',
    })
    mockApiCall.mockRejectedValueOnce(conflict)
    const onSaved = jest.fn(async () => undefined)
    render(<VisitLifecycleActions visit={visit} access={access} onSaved={onSaved} />)

    fireEvent.click(screen.getByRole('button', { name: 'patient.visits.lifecycle.cancel' }))
    const reason = screen.getByPlaceholderText('patient.visits.lifecycle.reasonPlaceholder')
    fireEvent.change(reason, { target: { value: 'Patient requested a different date' } })
    fireEvent.keyDown(reason, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(mockShowConflict).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(reason).toHaveValue('Patient requested a different date')
    const conflictOptions = mockShowConflict.mock.calls[0]?.[0] as { onRefresh?: () => void }
    conflictOptions.onRefresh?.()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('focuses the empty required reason and hides actions the actor cannot perform', async () => {
    const { rerender } = render(
      <VisitLifecycleActions visit={visit} access={access} onSaved={() => undefined} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'patient.visits.lifecycle.noShow' }))
    fireEvent.click(screen.getByRole('button', { name: 'patient.visits.lifecycle.apply' }))
    const reason = screen.getByPlaceholderText('patient.visits.lifecycle.reasonPlaceholder')
    expect(reason).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('patient.visits.lifecycle.reasonRequired')

    rerender(
      <VisitLifecycleActions
        visit={{ ...visit, status: 'completed', confirmationApplicable: false }}
        access={{ ...access, canCorrect: false, canSettle: false }}
        onSaved={() => undefined}
      />,
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'patient.visits.lifecycle.reopen' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'patient.visits.lifecycle.settle' })).not.toBeInTheDocument()
    expect(screen.getByText('patient.visits.lifecycle.reopenReadOnly')).toBeVisible()
    expect(screen.getByText('patient.visits.lifecycle.settlementReadOnly')).toBeVisible()
  })
})
