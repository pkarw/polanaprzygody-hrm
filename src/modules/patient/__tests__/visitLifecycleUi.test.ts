import { describe, expect, it } from '@jest/globals'
import type { PatientVisitAccess } from '../components/usePatientVisitAccess'
import { resolveVisitLifecycleAvailability } from '../lib/visitLifecycleUi'

function access(overrides: Partial<PatientVisitAccess> = {}): PatientVisitAccess {
  return {
    status: 'ready',
    canView: true,
    canManage: true,
    canCorrect: true,
    canSettle: true,
    ...overrides,
  }
}

describe('visit lifecycle UI availability', () => {
  it('keeps planned management separate from settlement', () => {
    expect(resolveVisitLifecycleAvailability(
      { status: 'planned', startsAt: '2026-09-30T08:00:00.000Z' },
      access({ canSettle: false }),
      new Date('2026-09-30T09:00:00.000Z'),
    )).toEqual({
      canChangeConfirmation: true,
      canClose: true,
      canComplete: true,
      canNoShow: true,
      canReopen: false,
      canChangeSettlement: false,
      isRecordReadOnly: false,
    })
  })

  it('requires both manage and correct to reopen a closed visit', () => {
    expect(resolveVisitLifecycleAvailability(
      { status: 'cancelled', startsAt: '2026-09-30T08:00:00.000Z' },
      access({ canCorrect: false }),
    )).toMatchObject({ canReopen: false, isRecordReadOnly: true })
    expect(resolveVisitLifecycleAvailability(
      { status: 'cancelled', startsAt: '2026-09-30T08:00:00.000Z' },
      access(),
    )).toMatchObject({ canReopen: true, isRecordReadOnly: true })
  })

  it('fails every action closed while feature discovery is unavailable', () => {
    expect(resolveVisitLifecycleAvailability(
      { status: 'planned', startsAt: '2026-09-30T08:00:00.000Z' },
      access({ status: 'unavailable' }),
    )).toEqual({
      canChangeConfirmation: false,
      canClose: false,
      canComplete: false,
      canNoShow: false,
      canReopen: false,
      canChangeSettlement: false,
      isRecordReadOnly: true,
    })
  })

  it('keeps complete and no-show unavailable until the visit starts', () => {
    expect(resolveVisitLifecycleAvailability(
      { status: 'planned', startsAt: '2026-09-30T10:00:00.000Z' },
      access(),
      new Date('2026-09-30T09:00:00.000Z'),
    )).toMatchObject({
      canChangeConfirmation: true,
      canClose: true,
      canComplete: false,
      canNoShow: false,
    })
  })
})
