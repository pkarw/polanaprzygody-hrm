"use client"

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { buildVisitSchedule } from '../lib/visitDateTime'
import type { VisitConflict, VisitConflictSeverity } from '../lib/visitConflicts'
import { usePatientVisitAccess } from './usePatientVisitAccess'

export type VisitConflictOverrideInput = {
  acknowledgedSignatures: string[]
  reason: string
}

export type VisitAvailabilityGateValue = {
  allowSubmit: true
  conflictOverride?: VisitConflictOverrideInput
}

type AvailabilityResponse = {
  conflicts: VisitConflict[]
  worstSeverity: VisitConflictSeverity | null
  checkedAt: string
}

type VisitAvailabilityCheckProps = {
  value: unknown
  values?: Record<string, unknown>
  setValue: (value: unknown) => void
  error?: string
  disabled?: boolean
  excludeVisitId?: string
}

function stringValue(values: Record<string, unknown> | undefined, key: string): string {
  const value = values?.[key]
  return typeof value === 'string' ? value : ''
}

function gateValue(value: unknown): VisitAvailabilityGateValue | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.allowSubmit !== true) return null
  const conflictOverride = record.conflictOverride
  if (!conflictOverride || typeof conflictOverride !== 'object') return { allowSubmit: true }
  const override = conflictOverride as Record<string, unknown>
  if (!Array.isArray(override.acknowledgedSignatures) || typeof override.reason !== 'string') {
    return { allowSubmit: true }
  }
  return {
    allowSubmit: true,
    conflictOverride: {
      acknowledgedSignatures: override.acknowledgedSignatures.filter(
        (item): item is string => typeof item === 'string',
      ),
      reason: override.reason,
    },
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function VisitAvailabilityCheck({
  value,
  values,
  setValue,
  error,
  disabled,
  excludeVisitId,
}: VisitAvailabilityCheckProps) {
  const t = useT()
  const access = usePatientVisitAccess()
  const [debouncedUrl, setDebouncedUrl] = React.useState<string | null>(null)
  const [overrideOpen, setOverrideOpen] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const [reasonError, setReasonError] = React.useState<string | null>(null)
  const reasonRef = React.useRef<HTMLTextAreaElement | null>(null)

  const probeUrl = React.useMemo(() => {
    const teamMemberId = stringValue(values, 'teamMemberId')
    const startsAtLocal = stringValue(values, 'startsAtLocal')
    const timeZone = stringValue(values, 'timeZone')
    if (!teamMemberId || !startsAtLocal || !timeZone || disabled) return null
    // Gate on `canManage`, not just `disabled`: `CrudForm` never derives a custom field's
    // `disabled` from `readOnly` (that is an overlay plus focus capture), so on a read-only
    // detail page this would otherwise fire a probe requiring `patient.visits.manage` — a 403
    // per page view, shown to the operator as "availability unavailable, the visit can still be
    // saved", which is the opposite of true for someone who cannot save at all.
    if (access.status === 'ready' && !access.canManage) return null
    try {
      const schedule = buildVisitSchedule({
        startsAtLocal,
        endsAtLocal: stringValue(values, 'endsAtLocal') || null,
        timeZone,
        startOffset: stringValue(values, 'startOffset') || null,
        endOffset: stringValue(values, 'endOffset') || null,
      }, {
        gap: t('patient.visits.validation.dstGap'),
        fold: t('patient.visits.validation.dstFold'),
        offset: t('patient.visits.validation.offset'),
        endAfterStart: t('patient.visits.validation.endAfterStart'),
      })
      const query = new URLSearchParams({ teamMemberId, startsAt: schedule.startsAt })
      if (schedule.endsAt) query.set('endsAt', schedule.endsAt)
      const resourceId = stringValue(values, 'resourceId')
      if (resourceId) query.set('resourceId', resourceId)
      if (excludeVisitId) query.set('excludeVisitId', excludeVisitId)
      return `/api/patient/visits/availability-check?${query.toString()}`
    } catch {
      return null
    }
  }, [access.canManage, access.status, disabled, excludeVisitId, t, values])

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedUrl(probeUrl), 300)
    return () => window.clearTimeout(timer)
  }, [probeUrl])

  const query = useQuery<AvailabilityResponse>({
    queryKey: ['patient.visits', 'availability-check', debouncedUrl],
    queryFn: () => readApiResultOrThrow<AvailabilityResponse>(debouncedUrl as string),
    enabled: Boolean(debouncedUrl),
    retry: false,
  })
  const conflicts = query.data?.conflicts ?? []
  const warnings = conflicts.filter((item) => item.severity === 'warning')
  const blocking = conflicts.filter((item) => item.severity === 'blocking')
  const info = conflicts.filter((item) => item.severity === 'info')
  const currentGate = gateValue(value)
  const checking = Boolean(probeUrl) && (query.isLoading || debouncedUrl !== probeUrl)

  React.useEffect(() => {
    let next: VisitAvailabilityGateValue | null = { allowSubmit: true }
    if (checking || blocking.length > 0 || (warnings.length > 0 && (access.status !== 'ready' || !access.canOverrideConflict))) {
      next = null
    } else if (warnings.length > 0) {
      const expected = Array.from(new Set(warnings.map((item) => item.signature))).sort()
      const acknowledged = currentGate?.conflictOverride?.acknowledgedSignatures.slice().sort() ?? []
      next = expected.length === acknowledged.length && expected.every((item, index) => item === acknowledged[index])
        ? currentGate
        : null
    }
    if (!sameValue(value, next)) setValue(next)
  }, [access.canOverrideConflict, access.status, blocking, checking, currentGate, setValue, value, warnings])

  const confirmOverride = React.useCallback(() => {
    const normalized = reason.trim()
    if (!normalized) {
      setReasonError(t('patient.visits.conflicts.reasonRequired'))
      reasonRef.current?.focus()
      return
    }
    setReasonError(null)
    setValue({
      allowSubmit: true,
      conflictOverride: {
        acknowledgedSignatures: Array.from(new Set(warnings.map((item) => item.signature))).sort(),
        reason: normalized,
      },
    } satisfies VisitAvailabilityGateValue)
    setOverrideOpen(false)
  }, [reason, setValue, t, warnings])

  if (!probeUrl) {
    return (
      <Alert data-visit-availability-state="idle" aria-live="polite">
        <AlertTitle>{t('patient.visits.conflicts.title')}</AlertTitle>
        <AlertDescription>{t('patient.visits.conflicts.idle')}</AlertDescription>
      </Alert>
    )
  }
  if (checking) {
    return (
      <Alert data-visit-availability-state="checking" aria-live="polite">
        <AlertTitle>{t('patient.visits.conflicts.title')}</AlertTitle>
        <AlertDescription>{t('patient.visits.conflicts.checking')}</AlertDescription>
      </Alert>
    )
  }
  if (query.error) {
    return (
      <Alert status="warning" data-visit-availability-state="error" aria-live="polite">
        <AlertTitle>{t('patient.visits.conflicts.unknownTitle')}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{t('patient.visits.conflicts.unknown')}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t('patient.common.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (conflicts.length === 0) {
    return (
      <Alert status="success" data-visit-availability-state="free" aria-live="polite">
        <AlertTitle>{t('patient.visits.conflicts.freeTitle')}</AlertTitle>
        <AlertDescription>{t('patient.visits.conflicts.free')}</AlertDescription>
      </Alert>
    )
  }

  const status = blocking.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : undefined
  const confirmed = Boolean(currentGate?.conflictOverride)
  return (
    <>
      <Alert status={status} data-visit-availability-state={status ?? 'info'} aria-live="polite">
        <AlertTitle>
          {blocking.length > 0
            ? t('patient.visits.conflicts.blockingTitle')
            : warnings.length > 0
              ? t('patient.visits.conflicts.warningTitle')
              : t('patient.visits.conflicts.infoTitle')}
        </AlertTitle>
        <AlertDescription className="space-y-3">
          <ul className="list-disc space-y-1 pl-5">
            {conflicts.map((item) => (
              <li key={item.signature}>
                {t(`patient.visits.conflicts.code.${item.code}`)} · {item.subjectName}
                {item.reasonLabel ? ` — ${item.reasonLabel}` : ''}
              </li>
            ))}
          </ul>
          {blocking.length > 0 ? <p>{t('patient.visits.conflicts.blockingHint')}</p> : null}
          {warnings.length > 0 && access.status === 'ready' && access.canOverrideConflict ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setReason(currentGate?.conflictOverride?.reason ?? '')
                setReasonError(null)
                setOverrideOpen(true)
                window.setTimeout(() => reasonRef.current?.focus(), 0)
              }}
            >
              {confirmed
                ? t('patient.visits.conflicts.overrideConfirmed')
                : t('patient.visits.conflicts.overrideAction')}
            </Button>
          ) : null}
          {warnings.length > 0 && access.status === 'ready' && !access.canOverrideConflict ? (
            <p>{t('patient.visits.conflicts.overrideForbidden')}</p>
          ) : null}
          {info.length > 0 && warnings.length === 0 && blocking.length === 0
            ? <p>{t('patient.visits.conflicts.infoHint')}</p>
            : null}
          {error ? <p className="text-status-error-text">{error}</p> : null}
        </AlertDescription>
      </Alert>

      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              confirmOverride()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('patient.visits.conflicts.overrideTitle')}</DialogTitle>
            <DialogDescription>{t('patient.visits.conflicts.overrideDescription')}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
            {warnings.map((item) => (
              <li key={item.signature}>{t(`patient.visits.conflicts.code.${item.code}`)} · {item.subjectName}</li>
            ))}
          </ul>
          <FormField
            id="patient-visit-conflict-override-reason"
            label={t('patient.visits.conflicts.reason')}
            error={reasonError ?? undefined}
            required
          >
            <Textarea
              ref={reasonRef}
              value={reason}
              maxLength={2_000}
              rows={4}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
          <p className="text-xs text-muted-foreground">{t('patient.visits.conflicts.shortcutHint')}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOverrideOpen(false)}>
              {t('patient.common.cancel')}
            </Button>
            <Button type="button" onClick={confirmOverride}>
              {t('patient.visits.conflicts.overrideConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
