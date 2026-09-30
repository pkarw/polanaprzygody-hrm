"use client"
import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

export type ClinicalAccess = 'unknown' | 'granted' | 'denied' | 'unavailable'

/**
 * Decides whether to show the clinical tabs on a patient card.
 *
 * There is no first-class client-side feature hook in this framework version — the version
 * history panel is the only surface that checks a feature, and it does so through its own
 * endpoint. Rather than invent an ACL endpoint or duplicate the grant logic in the browser,
 * this asks the authoritative source: one cheap `pageSize=1` read against the diagnoses route,
 * whose `metadata.requireFeatures` is `patient.clinical.view`.
 *
 * That is deliberate in two ways:
 *
 * - **The server stays the only authority.** A UI-side grant check could drift from the route's
 *   own gate; this cannot, because it *is* the route's gate.
 *   Hiding the tab is presentation only — every clinical endpoint refuses an unauthorized
 *   caller regardless of what the browser renders.
 * - **`denied` hides the tabs rather than showing an empty one.** A reception user has no
 *   business seeing that a "Diagnoses" section exists and is empty-or-forbidden; the spec wants
 *   the clinical surface absent for them, not merely unreadable.
 *
 * `unavailable` covers a transport failure, where the honest answer is "we could not tell". The
 * tabs are shown in that case so the operator can retry inside them, rather than silently
 * losing a surface they may well be entitled to.
 */
export function useClinicalAccess(patientId: string): ClinicalAccess {
  const [access, setAccess] = React.useState<ClinicalAccess>('unknown')

  React.useEffect(() => {
    let cancelled = false
    setAccess('unknown')
    async function probe() {
      try {
        const call = await apiCall(
          `/api/patient/diagnoses?patientId=${encodeURIComponent(patientId)}&pageSize=1`,
          { method: 'GET' },
        )
        if (cancelled) return
        if (call.status === 403 || call.status === 401) {
          setAccess('denied')
          return
        }
        // A 404 means the patient is not visible, which the card as a whole already handles;
        // anything else non-2xx is a transport-level unknown rather than a denial.
        setAccess(call.status >= 200 && call.status < 300 ? 'granted' : 'unavailable')
      } catch {
        if (!cancelled) setAccess('unavailable')
      }
    }
    void probe()
    return () => {
      cancelled = true
    }
  }, [patientId])

  return access
}

export default useClinicalAccess
