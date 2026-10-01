import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'
import type { PatientVisitAccess } from '../components/usePatientVisitAccess'
import {
  formatVisitConflictRejection,
  readVisitConflictRejection,
  resolveVisitLifecycleAvailability,
} from '../lib/visitLifecycleUi'

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

/**
 * The server re-evaluates conflicts under the slot lock, so a save can be refused after a clean
 * availability check — or after no check at all on the degraded path. The rejection body carries
 * the reason; the token in `Error.message` is not an i18n key, so rendering it unchanged shows
 * the operator a literal "visit_conflict_unacknowledged" and discards the list.
 */
describe('visit conflict rejection mapping', () => {
  const translate = (key: string) => `t:${key}`

  it('recognizes both rejection tokens from the message or the body field', () => {
    expect(readVisitConflictRejection({ message: 'visit_conflict_blocking', conflicts: [] }))
      .toMatchObject({ kind: 'visit_conflict_blocking' })
    expect(readVisitConflictRejection({ error: 'visit_conflict_unacknowledged', conflicts: [] }))
      .toMatchObject({ kind: 'visit_conflict_unacknowledged' })
  })

  it('ignores unrelated failures so they keep their own handling', () => {
    expect(readVisitConflictRejection(null)).toBeNull()
    expect(readVisitConflictRejection(new Error('Request failed (500)'))).toBeNull()
    expect(readVisitConflictRejection({ message: 'visit_end_not_after_start' })).toBeNull()
  })

  it('keeps only well-formed conflict entries', () => {
    const detail = readVisitConflictRejection({
      message: 'visit_conflict_blocking',
      conflicts: [{ code: 'member_absence', subjectName: 'Anna' }, null, { subjectName: 'no code' }],
    })
    expect(detail?.conflicts).toEqual([{ code: 'member_absence', subjectName: 'Anna' }])
  })

  it('tolerates a rejection whose conflicts array is missing', () => {
    expect(readVisitConflictRejection({ message: 'visit_conflict_blocking' }))
      .toEqual({ kind: 'visit_conflict_blocking', conflicts: [] })
  })

  it('itemizes the conflicts through the translated code keys', () => {
    const message = formatVisitConflictRejection({
      kind: 'visit_conflict_unacknowledged',
      conflicts: [
        { code: 'member_double_booked', subjectName: 'Anna Nowicka' },
        { code: 'member_absence', subjectName: 'Jan Kowalski', reasonLabel: 'Leave' },
      ],
    }, translate)
    expect(message).toBe([
      't:patient.visits.conflicts.warningTitle',
      '• t:patient.visits.conflicts.code.member_double_booked · Anna Nowicka',
      '• t:patient.visits.conflicts.code.member_absence · Jan Kowalski — Leave',
      't:patient.visits.conflicts.staleHint',
    ].join('\n'))
    // Never the raw token.
    expect(message).not.toContain('visit_conflict')
  })

  it('uses the blocking title and hint for a rejection that cannot be overridden', () => {
    const message = formatVisitConflictRejection({
      kind: 'visit_conflict_blocking',
      conflicts: [{ code: 'resource_inactive', subjectName: 'Gabinet 2' }],
    }, translate)
    expect(message).toContain('t:patient.visits.conflicts.blockingTitle')
    expect(message).toContain('t:patient.visits.conflicts.blockingHint')
  })
})

describe('visit form wires the conflict rejection mapping', () => {
  const source = readFileSync(
    path.join(__dirname, '..', 'components', 'VisitForm.tsx'),
    'utf8',
  )

  it('routes both the create and the update save through it', () => {
    expect(source.match(/withVisitConflictErrors\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(source).toContain('withVisitConflictErrors(() => createCrud(')
    expect(source).toContain('withVisitConflictErrors(() => updateCrud(')
  })

  it('gives the therapist and services custom fields a programmatic label', () => {
    // `CrudForm` renders a custom field's own label without `htmlFor`, so these wrap in
    // `FormField` and blank the built-in label instead.
    expect(source).toContain('id="patient-visit-teamMemberId"')
    expect(source).toContain('id="patient-visit-serviceProductIds"')
  })
})

describe('availability probe respects the manage feature', () => {
  it('does not probe a route the operator cannot call', () => {
    const source = readFileSync(
      path.join(__dirname, '..', 'components', 'VisitAvailabilityCheck.tsx'),
      'utf8',
    )
    expect(source).toContain("access.status === 'ready' && !access.canManage")
  })
})
