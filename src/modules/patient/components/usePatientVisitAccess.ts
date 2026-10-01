"use client"
import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useOrganizationScopeDetail } from '@open-mercato/shared/lib/frontend/useOrganizationScope'

export type PatientVisitAccess = {
  status: 'unknown' | 'ready' | 'unavailable'
  canView: boolean
  canManage: boolean
  canCorrect: boolean
  canSettle: boolean
  canOverrideConflict?: boolean
}

type FeatureCheckResponse = { granted?: string[] }

export function usePatientVisitAccess(): PatientVisitAccess {
  const { organizationId, tenantId } = useOrganizationScopeDetail()
  const [access, setAccess] = React.useState<PatientVisitAccess>({
    status: 'unknown',
    canView: false,
    canManage: false,
    canCorrect: false,
    canSettle: false,
    canOverrideConflict: false,
  })

  React.useEffect(() => {
    let cancelled = false
    setAccess({
      status: 'unknown',
      canView: false,
      canManage: false,
      canCorrect: false,
      canSettle: false,
      canOverrideConflict: false,
    })
    void (async () => {
      try {
        const response = await apiCall<FeatureCheckResponse>('/api/auth/feature-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            features: [
              'patient.visits.view',
              'patient.visits.manage',
              'patient.visits.correct',
              'patient.visits.settle',
              'patient.visits.override_conflict',
            ],
          }),
        })
        if (cancelled) return
        if (!response.ok) {
          setAccess({
            status: 'unavailable',
            canView: false,
            canManage: false,
            canCorrect: false,
            canSettle: false,
            canOverrideConflict: false,
          })
          return
        }
        const granted = new Set(Array.isArray(response.result?.granted) ? response.result.granted : [])
        setAccess({
          status: 'ready',
          canView: granted.has('patient.visits.view'),
          canManage: granted.has('patient.visits.manage'),
          canCorrect: granted.has('patient.visits.correct'),
          canSettle: granted.has('patient.visits.settle'),
          canOverrideConflict: granted.has('patient.visits.override_conflict'),
        })
      } catch {
        if (!cancelled) {
          setAccess({
            status: 'unavailable',
            canView: false,
            canManage: false,
            canCorrect: false,
            canSettle: false,
            canOverrideConflict: false,
          })
        }
      }
    })()
    return () => { cancelled = true }
  }, [organizationId, tenantId])

  return access
}

export default usePatientVisitAccess
