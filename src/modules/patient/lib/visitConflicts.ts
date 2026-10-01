import { createHash } from 'node:crypto'

export const VISIT_CONFLICT_CODES = [
  'member_absence',
  'member_unavailable',
  'member_outside_availability',
  'member_no_schedule',
  'member_double_booked',
  'resource_inactive',
  'resource_unavailable',
  'resource_outside_availability',
  'resource_double_booked',
  'availability_unknown',
] as const

export type VisitConflictCode = (typeof VISIT_CONFLICT_CODES)[number]
export type VisitConflictSeverity = 'blocking' | 'warning' | 'info'
export type VisitConflictSubjectType = 'member' | 'resource'

export type VisitConflict = {
  code: VisitConflictCode
  severity: VisitConflictSeverity
  subjectType: VisitConflictSubjectType
  subjectId: string
  subjectName: string
  from: string
  to: string | null
  reasonLabel?: string
  conflictingVisitId?: string
  signature: string
}

export type VisitConflictWindow = {
  start: Date
  end: Date
  reasonKind?: 'leave' | 'manual'
  reasonLabel?: string
}

export type VisitSubjectAvailability = {
  subjectType: VisitConflictSubjectType
  subjectId: string
  subjectName: string
  hasSchedule: boolean
  isActive?: boolean
  unknown?: boolean
  availableWindows: VisitConflictWindow[]
  unavailableWindows: VisitConflictWindow[]
}

export type OverlappingVisit = {
  id: string
  teamMemberId: string
  resourceId?: string | null
  startsAt: Date
  endsAt?: Date | null
}

export type VisitConflictDraft = {
  teamMemberId: string
  teamMemberName: string
  resourceId?: string | null
  resourceName?: string | null
  startsAt: Date
  endsAt?: Date | null
}

export function redactVisitConflictsForRead(
  conflicts: VisitConflict[],
  access: { exposeMemberReason: boolean; exposeResourceReason: boolean },
): VisitConflict[] {
  return conflicts.map((conflict) => {
    const canExpose = conflict.subjectType === 'member'
      ? access.exposeMemberReason
      : access.exposeResourceReason
    if (canExpose) return conflict
    const { reasonLabel: _reasonLabel, ...publicConflict } = conflict
    if (conflict.code === 'member_absence') {
      return {
        ...publicConflict,
        code: 'member_unavailable',
        // The write remains blocked, but the read response does not reveal whether the
        // unavailable window came from leave, sickness, or another staff-owned reason.
        severity: 'blocking',
      }
    }
    return publicConflict
  })
}

const severityByCode: Record<VisitConflictCode, VisitConflictSeverity> = {
  member_absence: 'blocking',
  member_unavailable: 'warning',
  member_outside_availability: 'warning',
  member_no_schedule: 'info',
  member_double_booked: 'warning',
  resource_inactive: 'blocking',
  resource_unavailable: 'warning',
  resource_outside_availability: 'warning',
  resource_double_booked: 'warning',
  availability_unknown: 'info',
}

function minuteIso(value: Date): string {
  const time = Math.floor(value.getTime() / 60_000) * 60_000
  return new Date(time).toISOString()
}

function conflictSignature(input: {
  code: VisitConflictCode
  subjectType: VisitConflictSubjectType
  subjectId: string
  from: Date
  to?: Date | null
  conflictingVisitId?: string
}): string {
  const material = [
    input.code,
    input.subjectType,
    input.subjectId,
    minuteIso(input.from),
    input.to ? minuteIso(input.to) : '',
    input.conflictingVisitId ?? '',
  ].join('|')
  return createHash('sha256').update(material).digest('hex')
}

function overlaps(
  leftStart: Date,
  leftEnd: Date | null | undefined,
  rightStart: Date,
  rightEnd: Date | null | undefined,
): boolean {
  const leftPoint = !leftEnd
  const rightPoint = !rightEnd
  if (leftPoint && rightPoint) return leftStart.getTime() === rightStart.getTime()
  if (leftPoint) return leftStart >= rightStart && leftStart < (rightEnd as Date)
  if (rightPoint) return rightStart >= leftStart && rightStart < leftEnd
  return leftStart < (rightEnd as Date) && rightStart < leftEnd
}

function containedBy(window: VisitConflictWindow, start: Date, end?: Date | null): boolean {
  if (!end) return start >= window.start && start < window.end
  return start >= window.start && end <= window.end
}

function createConflict(input: {
  code: VisitConflictCode
  subject: VisitSubjectAvailability
  from: Date
  to?: Date | null
  reasonLabel?: string
  conflictingVisitId?: string
}): VisitConflict {
  return {
    code: input.code,
    severity: severityByCode[input.code],
    subjectType: input.subject.subjectType,
    subjectId: input.subject.subjectId,
    subjectName: input.subject.subjectName,
    from: input.from.toISOString(),
    to: input.to?.toISOString() ?? null,
    ...(input.reasonLabel ? { reasonLabel: input.reasonLabel } : {}),
    ...(input.conflictingVisitId ? { conflictingVisitId: input.conflictingVisitId } : {}),
    signature: conflictSignature({
      code: input.code,
      subjectType: input.subject.subjectType,
      subjectId: input.subject.subjectId,
      from: input.from,
      to: input.to,
      conflictingVisitId: input.conflictingVisitId,
    }),
  }
}

function availabilityConflicts(
  draft: VisitConflictDraft,
  subject: VisitSubjectAvailability,
): VisitConflict[] {
  if (subject.subjectType === 'resource' && subject.isActive === false) {
    return [createConflict({
      code: 'resource_inactive',
      subject,
      from: draft.startsAt,
      to: draft.endsAt,
    })]
  }
  if (subject.unknown) {
    return [createConflict({
      code: 'availability_unknown',
      subject,
      from: draft.startsAt,
      to: draft.endsAt,
    })]
  }

  const conflicts: VisitConflict[] = []
  for (const window of subject.unavailableWindows) {
    if (!overlaps(draft.startsAt, draft.endsAt, window.start, window.end)) continue
    const code = subject.subjectType === 'member'
      ? window.reasonKind === 'leave' ? 'member_absence' : 'member_unavailable'
      : 'resource_unavailable'
    conflicts.push(createConflict({
      code,
      subject,
      from: window.start,
      to: window.end,
      reasonLabel: window.reasonLabel,
    }))
  }

  if (!subject.hasSchedule) {
    if (subject.subjectType === 'member') {
      conflicts.push(createConflict({
        code: 'member_no_schedule',
        subject,
        from: draft.startsAt,
        to: draft.endsAt,
      }))
    }
  } else if (!subject.availableWindows.some((window) => containedBy(window, draft.startsAt, draft.endsAt))) {
    conflicts.push(createConflict({
      code: subject.subjectType === 'member'
        ? 'member_outside_availability'
        : 'resource_outside_availability',
      subject,
      from: draft.startsAt,
      to: draft.endsAt,
    }))
  }
  return conflicts
}

export function evaluateVisitConflicts(input: {
  draft: VisitConflictDraft
  subjects: VisitSubjectAvailability[]
  overlappingVisits: OverlappingVisit[]
}): VisitConflict[] {
  const { draft } = input
  const byKey = new Map(input.subjects.map((subject) => [
    `${subject.subjectType}:${subject.subjectId}`,
    subject,
  ]))
  const conflicts = input.subjects.flatMap((subject) => availabilityConflicts(draft, subject))

  for (const visit of input.overlappingVisits) {
    if (!overlaps(draft.startsAt, draft.endsAt, visit.startsAt, visit.endsAt)) continue
    if (visit.teamMemberId === draft.teamMemberId) {
      const subject = byKey.get(`member:${draft.teamMemberId}`)
      if (subject) {
        conflicts.push(createConflict({
          code: 'member_double_booked',
          subject,
          from: visit.startsAt,
          to: visit.endsAt,
          conflictingVisitId: visit.id,
        }))
      }
    }
    if (draft.resourceId && visit.resourceId === draft.resourceId) {
      const subject = byKey.get(`resource:${draft.resourceId}`)
      if (subject) {
        conflicts.push(createConflict({
          code: 'resource_double_booked',
          subject,
          from: visit.startsAt,
          to: visit.endsAt,
          conflictingVisitId: visit.id,
        }))
      }
    }
  }

  return conflicts.sort((left, right) => {
    const severityOrder = { blocking: 0, warning: 1, info: 2 }
    return severityOrder[left.severity] - severityOrder[right.severity]
      || left.code.localeCompare(right.code)
      || left.signature.localeCompare(right.signature)
  })
}

export function worstVisitConflictSeverity(conflicts: VisitConflict[]): VisitConflictSeverity | null {
  if (conflicts.some((conflict) => conflict.severity === 'blocking')) return 'blocking'
  if (conflicts.some((conflict) => conflict.severity === 'warning')) return 'warning'
  if (conflicts.some((conflict) => conflict.severity === 'info')) return 'info'
  return null
}
