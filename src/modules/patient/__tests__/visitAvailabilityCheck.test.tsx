/** @jest-environment jsdom */
import * as React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { VisitAvailabilityCheck } from '../components/VisitAvailabilityCheck'
import type { VisitConflict } from '../lib/visitConflicts'

const mockUseQuery = jest.fn()
let canOverrideConflict = true

jest.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string) => key,
}))

jest.mock('../components/usePatientVisitAccess', () => ({
  usePatientVisitAccess: () => ({
    status: 'ready',
    canView: true,
    canManage: true,
    canCorrect: true,
    canSettle: true,
    canOverrideConflict,
  }),
}))

const values = {
  teamMemberId: '11111111-1111-4111-8111-111111111111',
  startsAtLocal: '2026-10-05T10:00',
  endsAtLocal: '2026-10-05T11:00',
  timeZone: 'UTC',
}

const warning: VisitConflict = {
  code: 'member_double_booked',
  severity: 'warning',
  subjectType: 'member',
  subjectId: values.teamMemberId,
  subjectName: 'Anna Nowicka',
  from: '2026-10-05T10:00:00.000Z',
  to: '2026-10-05T11:00:00.000Z',
  signature: 'sig-warning',
}

function result(conflicts: VisitConflict[], error: Error | null = null) {
  return {
    data: error ? undefined : { conflicts, worstSeverity: conflicts[0]?.severity ?? null, checkedAt: '2026-10-05T09:00:00Z' },
    error,
    isLoading: false,
    refetch: jest.fn(),
  }
}

function Harness({ onSet, initialValue = { allowSubmit: true } }: {
  onSet: (value: unknown) => void
  initialValue?: unknown
}) {
  const [value, setValue] = React.useState(initialValue)
  return (
    <VisitAvailabilityCheck
      value={value}
      values={values}
      setValue={(next) => {
        onSet(next)
        setValue(next)
      }}
    />
  )
}

describe('VisitAvailabilityCheck', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    canOverrideConflict = true
    mockUseQuery.mockReturnValue(result([]))
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  async function finishDebounce() {
    await act(async () => { jest.advanceTimersByTime(301) })
  }

  it('keeps submit gated while checking and allows it after a clean result', async () => {
    const setValue = jest.fn()
    render(<Harness onSet={setValue} />)
    expect(setValue).toHaveBeenCalledWith(null)
    await finishDebounce()
    expect(setValue).toHaveBeenLastCalledWith({ allowSubmit: true })
    expect(screen.getByText('patient.visits.conflicts.freeTitle')).toBeVisible()
  })

  it('requires an exact explicit override for warnings', async () => {
    mockUseQuery.mockReturnValue(result([warning]))
    const setValue = jest.fn()
    render(<Harness onSet={setValue} />)
    await finishDebounce()
    expect(setValue).toHaveBeenLastCalledWith(null)
    fireEvent.click(screen.getByRole('button', { name: 'patient.visits.conflicts.overrideAction' }))
    const reason = screen.getByRole('textbox', { name: /patient.visits.conflicts.reason/ })
    fireEvent.change(reason, { target: { value: 'Group appointment approved by coordinator' } })
    fireEvent.keyDown(reason, { key: 'Enter', ctrlKey: true })
    expect(setValue).toHaveBeenLastCalledWith({
      allowSubmit: true,
      conflictOverride: {
        acknowledgedSignatures: ['sig-warning'],
        reason: 'Group appointment approved by coordinator',
      },
    })
  })

  it('blocks warnings without permission and degrades open on probe errors', async () => {
    canOverrideConflict = false
    mockUseQuery.mockReturnValue(result([warning]))
    const setValue = jest.fn()
    const first = render(<Harness onSet={setValue} />)
    await finishDebounce()
    expect(setValue).toHaveBeenLastCalledWith(null)
    expect(screen.getByText('patient.visits.conflicts.overrideForbidden')).toBeVisible()

    first.unmount()
    mockUseQuery.mockReturnValue(result([], new Error('planner unavailable')))
    render(<Harness onSet={setValue} initialValue={null} />)
    await finishDebounce()
    expect(setValue).toHaveBeenLastCalledWith({ allowSubmit: true })
    expect(screen.getByText('patient.visits.conflicts.unknownTitle')).toBeVisible()
  })
})
