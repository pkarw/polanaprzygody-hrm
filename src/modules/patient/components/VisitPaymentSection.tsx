"use client"
import * as React from 'react'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { showRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { PatientVisitItem, PatientVisitPayment } from '../types'
import type { PatientVisitAccess } from './usePatientVisitAccess'

type PaymentActionResult = {
  ok: true
  updatedAt: string
  paymentLink: { id: string; slug: string; url: string; status: PatientVisitPayment['status'] } | null
  paymentLinkError: { code: string; message: string } | null
  paymentLinkEmailQueued?: boolean
  paymentLinkEmailError?: { code: string; message: string } | null
}

function isVersionConflict(error: unknown): error is { status: 409; code: 'version_conflict'; currentUpdatedAt?: string } {
  if (!error || typeof error !== 'object') return false
  const candidate = error as Record<string, unknown>
  return candidate.status === 409 && candidate.code === 'version_conflict'
}

function paymentBadgeVariant(status: PatientVisitPayment['status']) {
  if (status === 'completed') return 'success' as const
  if (status === 'pending' || status === 'processing') return 'info' as const
  if (status === 'failed' || status === 'expired' || status === 'cancelled') return 'warning' as const
  return 'neutral' as const
}

export function VisitPaymentSection({
  visit,
  access,
  onSaved,
}: {
  visit: PatientVisitItem
  access: PatientVisitAccess
  onSaved: () => Promise<unknown> | unknown
}) {
  const t = useT()
  const [activeAction, setActiveAction] = React.useState<'link' | 'email' | 'copy' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [announcement, setAnnouncement] = React.useState('')
  const errorRef = React.useRef<HTMLDivElement | null>(null)
  const emailOperationKeyRef = React.useRef<string | null>(null)
  const canManage = access.status === 'ready' && access.canManage
  const payment = visit.payment
  const canRegenerate = payment && ['inactive', 'expired', 'failed'].includes(payment.status)
  const canEmail = payment && ['pending', 'processing'].includes(payment.status)

  const run = React.useCallback(async (kind: 'link' | 'email') => {
    if (activeAction) return
    setActiveAction(kind)
    setError(null)
    const emailOperationKey = kind === 'email'
      ? emailOperationKeyRef.current ?? crypto.randomUUID()
      : null
    if (emailOperationKey) emailOperationKeyRef.current = emailOperationKey
    try {
      const result = await readApiResultOrThrow<PaymentActionResult>(
        `/api/patient/visits/${encodeURIComponent(visit.id)}/payment-link${kind === 'email' ? '/email' : ''}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(emailOperationKey ? { 'idempotency-key': emailOperationKey } : {}),
          },
          body: JSON.stringify({ expectedUpdatedAt: visit.updatedAt }),
        },
      )
      const failure = result.paymentLinkEmailError ?? result.paymentLinkError
      if (failure) throw new Error(t(`patient.visits.payment.errors.${failure.code}`, failure.message))
      setAnnouncement(kind === 'email'
        ? t('patient.visits.payment.emailQueued')
        : t('patient.visits.payment.linkReady'))
      if (kind === 'email') emailOperationKeyRef.current = null
      await onSaved()
    } catch (caught) {
      if (isVersionConflict(caught)) {
        showRecordConflict({
          title: t('patient.visits.payment.conflictTitle'),
          message: t('patient.visits.payment.conflict'),
          currentUpdatedAt: caught.currentUpdatedAt ?? null,
          onRefresh: () => { void onSaved() },
        })
      } else {
        setError(caught instanceof Error ? caught.message : t('patient.visits.payment.error'))
        queueMicrotask(() => errorRef.current?.focus())
      }
    } finally {
      setActiveAction(null)
    }
  }, [activeAction, onSaved, t, visit.id, visit.updatedAt])

  const copy = React.useCallback(async () => {
    if (!payment?.url || activeAction) return
    setActiveAction('copy')
    setError(null)
    try {
      await navigator.clipboard.writeText(payment.url)
      setAnnouncement(t('patient.visits.payment.copied'))
    } catch {
      setError(t('patient.visits.payment.copyError'))
      queueMicrotask(() => errorRef.current?.focus())
    } finally {
      setActiveAction(null)
    }
  }, [activeAction, payment?.url, t])

  return (
    <section
      className="rounded-lg border bg-card p-4"
      aria-labelledby={`patient-visit-payment-${visit.id}`}
      data-visit-payment-section=""
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id={`patient-visit-payment-${visit.id}`} className="text-sm font-medium">
              {t('patient.visits.payment.title')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('patient.visits.payment.description')}</p>
          </div>
          {payment ? (
            <StatusBadge variant={paymentBadgeVariant(payment.status)} appearance="light" dot>
              {t(`patient.visits.payment.status.${payment.status}`)}
            </StatusBadge>
          ) : null}
        </div>

        {error ? (
          <div ref={errorRef} tabIndex={-1}>
            <Alert status="error" data-visit-payment-error="">
              <AlertTitle>{t('patient.visits.payment.errorTitle')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        {payment?.configurationError ? (
          <Alert status="error">
            <AlertDescription>{t('patient.visits.payment.originError')}</AlertDescription>
          </Alert>
        ) : null}

        {payment?.url ? (
          <div className="space-y-1">
            <label htmlFor={`patient-visit-payment-url-${visit.id}`} className="text-sm font-medium">
              {t('patient.visits.payment.url')}
            </label>
            <Input id={`patient-visit-payment-url-${visit.id}`} value={payment.url} readOnly />
          </div>
        ) : !payment ? (
          <p className="text-sm text-muted-foreground" data-visit-payment-empty="">
            {visit.services.length === 0
              ? t('patient.visits.payment.noServices')
              : t('patient.visits.payment.empty')}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" aria-busy={activeAction !== null}>
          {payment?.url ? (
            <Button type="button" size="sm" variant="outline" disabled={activeAction !== null} onClick={() => void copy()}>
              {t('patient.visits.payment.copy')}
            </Button>
          ) : null}
          {canEmail ? (
            <Button type="button" size="sm" variant="outline" disabled={!canManage || activeAction !== null} onClick={() => void run('email')}>
              {activeAction === 'email' ? t('patient.visits.payment.sending') : t('patient.visits.payment.sendEmail')}
            </Button>
          ) : null}
          {!payment || canRegenerate ? (
            <Button
              type="button"
              size="sm"
              disabled={!canManage || visit.services.length === 0 || activeAction !== null}
              onClick={() => void run('link')}
            >
              {activeAction === 'link'
                ? t('patient.visits.payment.generating')
                : canRegenerate
                  ? t('patient.visits.payment.regenerate')
                  : t('patient.visits.payment.generate')}
            </Button>
          ) : null}
        </div>
        {!canManage ? <p className="text-xs text-muted-foreground">{t('patient.visits.payment.readOnly')}</p> : null}
        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      </div>
    </section>
  )
}
