"use client"
import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

export type ClinicalFilesAvailability = 'unknown' | 'available' | 'unavailable'

/**
 * Whether clinical file storage is usable on this installation.
 *
 * Asked of the server rather than read from a client-visible flag, for the same reason the
 * clinical-tab probe is: the gate lives in `lib/clinicalFileGate.ts` and is evaluated server-side,
 * so mirroring it into the bundle would create a second copy that can disagree with the one that
 * actually refuses the write.
 *
 * The probe is a deliberately harmless one — an OPTIONS-shaped POST with an empty body against the
 * upload route. While the gate is closed the route answers 503 with
 * `clinical_file_protection_unavailable` *before* reading the body, so nothing is uploaded and no
 * validation error is produced. Any other status means the gate is open and the real contract
 * (payload validation, feature checks) applies.
 *
 * `unknown` renders neither the banner nor an attach action, so the tab does not briefly claim the
 * feature works and then contradict itself.
 */
export function useClinicalFilesAvailability(): ClinicalFilesAvailability {
  const [availability, setAvailability] = React.useState<ClinicalFilesAvailability>('unknown')

  React.useEffect(() => {
    let cancelled = false
    async function probe() {
      try {
        const call = await apiCall('/api/patient/attachment-links/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (cancelled) return
        // 503 is the gate's own answer. A 401/403 means this operator lacks the manage feature,
        // which is not a statement about the platform capability — the tab then simply offers no
        // attach action, which is already the case for a view-only operator.
        setAvailability(call.status === 503 ? 'unavailable' : 'available')
      } catch {
        // A transport failure says nothing about the gate. Reporting `unavailable` would put a
        // misleading platform banner on the page over what is probably a network blip.
        if (!cancelled) setAvailability('unknown')
      }
    }
    void probe()
    return () => {
      cancelled = true
    }
  }, [])

  return availability
}

export default useClinicalFilesAvailability
