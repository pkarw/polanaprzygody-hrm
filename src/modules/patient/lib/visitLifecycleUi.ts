import type { PatientVisitAccess } from '../components/usePatientVisitAccess'
import type { PatientVisitItem } from '../types'

export type VisitLifecycleAvailability = {
  canChangeConfirmation: boolean
  canClose: boolean
  canComplete: boolean
  canNoShow: boolean
  canReopen: boolean
  canChangeSettlement: boolean
  isRecordReadOnly: boolean
}

/**
 * Pure UI oracle mirroring the command feature/state matrix.
 *
 * This never grants access optimistically: feature probing must be ready, closed
 * records stay read-only, and reopen requires both manage and correct.
 */
export function resolveVisitLifecycleAvailability(
  visit: Pick<PatientVisitItem, 'status' | 'startsAt'>,
  access: PatientVisitAccess,
  now: Date = new Date(),
): VisitLifecycleAvailability {
  const ready = access.status === 'ready'
  const planned = visit.status === 'planned'
  const hasStarted = Date.parse(visit.startsAt) <= now.getTime()
  return {
    canChangeConfirmation: ready && planned && access.canManage,
    canClose: ready && planned && access.canManage,
    canComplete: ready && planned && access.canManage && hasStarted,
    canNoShow: ready && planned && access.canManage && hasStarted,
    canReopen: ready && !planned && access.canManage && access.canCorrect,
    canChangeSettlement: ready && access.canSettle,
    isRecordReadOnly: !planned || !ready || !access.canManage,
  }
}

/** The two 422 bodies the visit write commands use to reject a conflicting schedule. */
const VISIT_CONFLICT_REJECTIONS = ['visit_conflict_blocking', 'visit_conflict_unacknowledged'] as const

type VisitConflictRejection = (typeof VISIT_CONFLICT_REJECTIONS)[number]

type RejectedConflict = {
  code: string
  subjectName?: string | null
  reasonLabel?: string | null
}

export type VisitConflictRejectionDetail = {
  kind: VisitConflictRejection
  conflicts: RejectedConflict[]
}

/**
 * Recognizes a conflict rejection thrown by `createCrud`/`updateCrud`.
 *
 * `raiseCrudError` spreads the response body onto the thrown error, so both the token and the
 * `conflicts` array survive — but the token lands in `Error.message`, and it is not an i18n
 * key. Rendering it unchanged shows the operator a literal
 * "visit_conflict_unacknowledged" and silently drops the list of what actually conflicted.
 */
export function readVisitConflictRejection(error: unknown): VisitConflictRejectionDetail | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { message?: unknown; error?: unknown; conflicts?: unknown }
  const token = [candidate.error, candidate.message]
    .find((value): value is VisitConflictRejection =>
      typeof value === 'string' && (VISIT_CONFLICT_REJECTIONS as readonly string[]).includes(value))
  if (!token) return null
  const conflicts = Array.isArray(candidate.conflicts)
    ? candidate.conflicts.filter((item): item is RejectedConflict =>
        Boolean(item) && typeof item === 'object' && typeof (item as RejectedConflict).code === 'string')
    : []
  return { kind: token, conflicts }
}

/**
 * Builds the operator-facing message for a conflict rejection.
 *
 * The server re-evaluates conflicts under the slot lock, so this fires whenever the schedule
 * moved between the availability check and the save — including the degraded path, where the
 * check could not run at all and the form let the operator submit anyway. The returned list is
 * the only place they learn what blocked it, which is why the spec requires it to be re-shown.
 */
export function formatVisitConflictRejection(
  detail: VisitConflictRejectionDetail,
  t: (key: string, fallback?: string) => string,
): string {
  const title = detail.kind === 'visit_conflict_blocking'
    ? t('patient.visits.conflicts.blockingTitle')
    : t('patient.visits.conflicts.warningTitle')
  const hint = detail.kind === 'visit_conflict_blocking'
    ? t('patient.visits.conflicts.blockingHint')
    : t('patient.visits.conflicts.staleHint')
  const lines = detail.conflicts.map((item) => {
    const label = t(`patient.visits.conflicts.code.${item.code}`)
    const subject = item.subjectName ? ` · ${item.subjectName}` : ''
    const reason = item.reasonLabel ? ` — ${item.reasonLabel}` : ''
    return `• ${label}${subject}${reason}`
  })
  return [title, ...lines, hint].filter(Boolean).join('\n')
}
