import { describe, expect, it } from '@jest/globals'
import {
  evaluateVisitConflicts,
  redactVisitConflictsForRead,
  worstVisitConflictSeverity,
  type VisitConflictDraft,
  type VisitSubjectAvailability,
} from '../lib/visitConflicts'

const memberId = '11111111-1111-4111-8111-111111111111'
const resourceId = '22222222-2222-4222-8222-222222222222'

function at(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 30, hour, minute))
}

function member(overrides: Partial<VisitSubjectAvailability> = {}): VisitSubjectAvailability {
  return {
    subjectType: 'member',
    subjectId: memberId,
    subjectName: 'Anna Nowicka',
    hasSchedule: true,
    availableWindows: [{ start: at(8), end: at(16) }],
    unavailableWindows: [],
    ...overrides,
  }
}

function resource(overrides: Partial<VisitSubjectAvailability> = {}): VisitSubjectAvailability {
  return {
    subjectType: 'resource',
    subjectId: resourceId,
    subjectName: 'Gabinet 2',
    hasSchedule: true,
    isActive: true,
    availableWindows: [{ start: at(8), end: at(16) }],
    unavailableWindows: [],
    ...overrides,
  }
}

function draft(overrides: Partial<VisitConflictDraft> = {}): VisitConflictDraft {
  return {
    teamMemberId: memberId,
    teamMemberName: 'Anna Nowicka',
    resourceId,
    resourceName: 'Gabinet 2',
    startsAt: at(10),
    endsAt: at(11),
    ...overrides,
  }
}

describe('evaluateVisitConflicts', () => {
  it('keeps half-open boundaries free while detecting real overlap', () => {
    const touching = evaluateVisitConflicts({
      draft: draft(),
      subjects: [member(), resource()],
      overlappingVisits: [{
        id: 'touching', teamMemberId: memberId, resourceId, startsAt: at(9), endsAt: at(10),
      }],
    })
    expect(touching).toEqual([])

    const overlapping = evaluateVisitConflicts({
      draft: draft(),
      subjects: [member(), resource()],
      overlappingVisits: [{
        id: 'overlap', teamMemberId: memberId, resourceId, startsAt: at(10, 30), endsAt: at(11, 30),
      }],
    })
    expect(overlapping.map((item) => item.code)).toEqual([
      'member_double_booked',
      'resource_double_booked',
    ])
  })

  it('treats two point visits at the same instant as conflicting', () => {
    const conflicts = evaluateVisitConflicts({
      draft: draft({ endsAt: null }),
      subjects: [member(), resource()],
      overlappingVisits: [{
        id: 'point', teamMemberId: memberId, resourceId, startsAt: at(10), endsAt: null,
      }],
    })
    expect(conflicts.map((item) => item.code)).toEqual([
      'member_double_booked',
      'resource_double_booked',
    ])
  })

  it('blocks staff absence, warns for manual exceptions and hides absent reason when omitted', () => {
    const conflicts = evaluateVisitConflicts({
      draft: draft(),
      subjects: [member({ unavailableWindows: [
        { start: at(9), end: at(12), reasonKind: 'leave', reasonLabel: 'Approved leave' },
        { start: at(10, 30), end: at(11, 30), reasonKind: 'manual' },
      ] }), resource()],
      overlappingVisits: [],
    })
    expect(conflicts.map((item) => [item.code, item.severity])).toEqual([
      ['member_absence', 'blocking'],
      ['member_unavailable', 'warning'],
    ])
    expect(conflicts[0]?.reasonLabel).toBe('Approved leave')
    expect(worstVisitConflictSeverity(conflicts)).toBe('blocking')
  })

  it('keeps an absence blocking but redacts its staff-owned reason and source for readers without access', () => {
    const [raw] = evaluateVisitConflicts({
      draft: draft(),
      subjects: [member({ unavailableWindows: [{
        start: at(9), end: at(12), reasonKind: 'leave', reasonLabel: 'Medical leave',
      }] })],
      overlappingVisits: [],
    })
    const [redacted] = redactVisitConflictsForRead(raw ? [raw] : [], {
      exposeMemberReason: false,
      exposeResourceReason: false,
    })
    expect(redacted).toMatchObject({ code: 'member_unavailable', severity: 'blocking' })
    expect(redacted).not.toHaveProperty('reasonLabel')
    expect(redactVisitConflictsForRead(raw ? [raw] : [], {
      exposeMemberReason: true,
      exposeResourceReason: false,
    })[0]).toEqual(raw)
  })

  it('reports no schedule as info and outside schedule as warning', () => {
    const noSchedule = evaluateVisitConflicts({
      draft: draft(), subjects: [member({ hasSchedule: false, availableWindows: [] })], overlappingVisits: [],
    })
    expect(noSchedule.map((item) => item.code)).toEqual(['member_no_schedule'])

    const outside = evaluateVisitConflicts({
      draft: draft({ startsAt: at(17), endsAt: at(18) }),
      subjects: [member()], overlappingVisits: [],
    })
    expect(outside.map((item) => item.code)).toEqual(['member_outside_availability'])
  })

  it('blocks an inactive resource even when planner availability is unknown', () => {
    const conflicts = evaluateVisitConflicts({
      draft: draft(),
      subjects: [resource({ isActive: false, unknown: true, availableWindows: [] })],
      overlappingVisits: [],
    })
    expect(conflicts.map((item) => item.code)).toEqual(['resource_inactive'])
  })

  it('changes a double-booking signature when the conflicting visit changes', () => {
    const evaluate = (id: string) => evaluateVisitConflicts({
      draft: draft(),
      subjects: [member()],
      overlappingVisits: [{ id, teamMemberId: memberId, startsAt: at(10), endsAt: at(11) }],
    })[0]?.signature
    expect(evaluate('visit-a')).not.toBe(evaluate('visit-b'))
  })

  it('stabilizes signatures within a minute but changes them at the next minute', () => {
    const evaluate = (seconds: number) => evaluateVisitConflicts({
      draft: draft(),
      subjects: [member()],
      overlappingVisits: [{
        id: 'visit-a', teamMemberId: memberId,
        startsAt: new Date(at(10).getTime() + seconds * 1000), endsAt: at(11),
      }],
    })[0]?.signature
    expect(evaluate(10)).toBe(evaluate(50))
    expect(evaluate(10)).not.toBe(evaluate(60))
  })
})
