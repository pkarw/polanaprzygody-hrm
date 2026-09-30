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
