import { describe, expect, it } from '@jest/globals'
import type { PatientVisitStatus } from '../data/entities'
import { assertPatientVisitTransition } from '../commands/visits'

const past = new Date('2026-09-30T09:00:00.000Z')
const now = new Date('2026-09-30T10:00:00.000Z')
const future = new Date('2026-09-30T11:00:00.000Z')

function expectTransitionFailure(
  current: PatientVisitStatus,
  target: PatientVisitStatus,
  startsAt: Date,
  status: number,
  code: string,
): void {
  try {
    assertPatientVisitTransition(current, target, startsAt, now)
    throw new Error('[internal] Expected transition to fail')
  } catch (error) {
    expect(error).toMatchObject({ status, body: { code } })
  }
}

describe('patient visit lifecycle matrix', () => {
  it.each<PatientVisitStatus>(['completed', 'cancelled', 'no_show'])(
    'allows an explicit planned → %s transition after the visit starts',
    (target) => {
      expect(() => assertPatientVisitTransition('planned', target, past, now)).not.toThrow()
    },
  )

  it.each<PatientVisitStatus>(['completed', 'cancelled', 'no_show'])(
    'allows an explicit %s → planned correction',
    (current) => {
      expect(() => assertPatientVisitTransition(current, 'planned', past, now)).not.toThrow()
    },
  )

  it('rejects no-op and closed-to-closed transitions', () => {
    expectTransitionFailure('planned', 'planned', past, 409, 'visit_status_unchanged')
    expectTransitionFailure('completed', 'cancelled', past, 409, 'visit_transition_not_allowed')
    expectTransitionFailure('cancelled', 'no_show', past, 409, 'visit_transition_not_allowed')
  })

  it('rejects future completion and no-show but permits future cancellation', () => {
    expectTransitionFailure('planned', 'completed', future, 422, 'visit_completion_before_start')
    expectTransitionFailure('planned', 'no_show', future, 422, 'visit_no_show_before_start')
    expect(() => assertPatientVisitTransition('planned', 'cancelled', future, now)).not.toThrow()
  })
})
