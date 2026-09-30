"use client"
import * as React from 'react'
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
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { showRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { PatientVisitItem } from '../types'
import type { PatientVisitAccess } from './usePatientVisitAccess'
import { resolveVisitLifecycleAvailability } from '../lib/visitLifecycleUi'

type VisitLifecycleResult = {
  ok: true
  id: string
  status: PatientVisitItem['status']
  confirmedAt: string | null
  isConfirmed: boolean
  confirmationApplicable: boolean
  isSettled: boolean
  settledAt: string | null
  updatedAt: string
}

type ActionDialogState =
  | { mode: 'closed' }
  | { mode: 'confirmation'; confirmed: boolean }
  | { mode: 'status'; status: 'planned' | 'completed' | 'cancelled' | 'no_show' }
  | { mode: 'settlement'; isSettled: boolean }

type VisitLifecycleActionsProps = {
  visit: PatientVisitItem
  access: PatientVisitAccess
  onSaved: () => Promise<unknown> | unknown
}

function actionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

function visitVersionConflict(error: unknown): { currentUpdatedAt: string | null } | null {
  if (!error || typeof error !== 'object') return null
  const value = error as Record<string, unknown>
  if (value.status !== 409 || value.code !== 'version_conflict') return null
  return {
    currentUpdatedAt: typeof value.currentUpdatedAt === 'string' ? value.currentUpdatedAt : null,
  }
}

export function VisitLifecycleActions({ visit, access, onSaved }: VisitLifecycleActionsProps) {
  const t = useT()
  const availability = resolveVisitLifecycleAvailability(visit, access)
  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    resourceId: string
    entityType: string
    entityId: string
    action: string
    retryLastMutation: () => Promise<boolean>
  }>({ contextId: `patient.visit.lifecycle.${visit.id}` })
  const [dialog, setDialog] = React.useState<ActionDialogState>({ mode: 'closed' })
  const [reason, setReason] = React.useState('')
  const [reasonError, setReasonError] = React.useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [announcement, setAnnouncement] = React.useState('')
  const openerRef = React.useRef<HTMLButtonElement | null>(null)
  const reasonRef = React.useRef<HTMLTextAreaElement | null>(null)
  const submittingRef = React.useRef(false)

  const invoke = React.useCallback(async (
    action: 'confirmation' | 'status' | 'settlement',
    payload: Record<string, unknown>,
    successMessage: string,
  ) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    setError(null)
    const requestPayload = { ...payload, expectedUpdatedAt: visit.updatedAt }
    try {
      await runMutation({
        operation: () => readApiResultOrThrow<VisitLifecycleResult>(
          `/api/patient/visits/${encodeURIComponent(visit.id)}/${action}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requestPayload),
          },
        ),
        context: {
          formId: `patient.visit.lifecycle.${visit.id}`,
          resourceKind: 'patient.visit',
          resourceId: visit.id,
          entityType: 'patient:patient_visit',
          entityId: visit.id,
          action,
          retryLastMutation,
        },
        mutationPayload: requestPayload,
      })
      setDialog({ mode: 'closed' })
      setReason('')
      setAnnouncement(successMessage)
      await onSaved()
    } catch (caught) {
      const conflict = visitVersionConflict(caught)
      if (conflict) {
        showRecordConflict({
          title: t('patient.visits.lifecycle.conflictTitle'),
          message: t('patient.visits.lifecycle.conflict'),
          currentUpdatedAt: conflict.currentUpdatedAt,
          onRefresh: () => { void onSaved() },
        })
      } else {
        setError(actionError(caught, t('patient.visits.lifecycle.error')))
      }
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }, [onSaved, retryLastMutation, runMutation, t, visit.id, visit.updatedAt])

  const openActionDialog = React.useCallback((
    next: Exclude<ActionDialogState, { mode: 'closed' }>,
    opener: HTMLButtonElement,
  ) => {
    openerRef.current = opener
    setReason('')
    setReasonError(null)
    setError(null)
    setDialog(next)
  }, [])

  const submitDialog = React.useCallback(async () => {
    const normalizedReason = reason.trim()
    const reasonRequired = dialog.mode === 'settlement'
      ? !dialog.isSettled
      : dialog.mode === 'status'
        ? dialog.status !== 'completed'
        : false
    if (reasonRequired && !normalizedReason) {
      setReasonError(t('patient.visits.lifecycle.reasonRequired'))
      reasonRef.current?.focus()
      return
    }
    if (dialog.mode === 'closed') return
    setReasonError(null)
    if (dialog.mode === 'confirmation') {
      await invoke(
        'confirmation',
        { confirmed: dialog.confirmed },
        dialog.confirmed
          ? t('patient.visits.lifecycle.flash.confirmed')
          : t('patient.visits.lifecycle.flash.unconfirmed'),
      )
      return
    }
    if (dialog.mode === 'settlement') {
      await invoke(
        'settlement',
        {
          isSettled: dialog.isSettled,
          ...(dialog.isSettled ? {} : { reason: normalizedReason }),
        },
        dialog.isSettled
          ? t('patient.visits.lifecycle.flash.settled')
          : t('patient.visits.lifecycle.flash.unsettled'),
      )
      return
    }
    await invoke(
      'status',
      {
        status: dialog.status,
        ...(dialog.status === 'completed' ? {} : { reason: normalizedReason }),
      },
      dialog.status === 'planned'
        ? t('patient.visits.lifecycle.flash.reopened')
        : dialog.status === 'completed'
          ? t('patient.visits.lifecycle.flash.completed')
        : t('patient.visits.lifecycle.flash.closed'),
    )
  }, [dialog, invoke, reason, t])

  const dialogNeedsReason = dialog.mode === 'settlement'
    ? !dialog.isSettled
    : dialog.mode === 'status'
      ? dialog.status !== 'completed'
      : false
  const dialogTitle = dialog.mode === 'confirmation'
    ? dialog.confirmed
      ? t('patient.visits.lifecycle.confirmTitle')
      : t('patient.visits.lifecycle.unconfirmTitle')
    : dialog.mode === 'settlement'
      ? dialog.isSettled
        ? t('patient.visits.lifecycle.settleTitle')
        : t('patient.visits.lifecycle.unsettleTitle')
      : dialog.mode === 'status' && dialog.status === 'planned'
      ? t('patient.visits.lifecycle.reopenTitle')
      : dialog.mode === 'status' && dialog.status === 'completed'
        ? t('patient.visits.lifecycle.completeTitle')
      : dialog.mode === 'status' && dialog.status === 'cancelled'
        ? t('patient.visits.lifecycle.cancelTitle')
        : t('patient.visits.lifecycle.noShowTitle')
  const dialogDescription = dialog.mode === 'confirmation'
    ? dialog.confirmed
      ? t('patient.visits.lifecycle.confirmHint')
      : t('patient.visits.lifecycle.unconfirmHint')
    : dialog.mode === 'settlement'
      ? dialog.isSettled
        ? t('patient.visits.lifecycle.settleHint')
        : t('patient.visits.lifecycle.unsettleHint')
      : dialog.mode === 'status' && dialog.status === 'planned'
      ? t('patient.visits.lifecycle.reopenHint')
      : dialog.mode === 'status' && dialog.status === 'completed'
        ? t('patient.visits.lifecycle.completeHint')
      : t('patient.visits.lifecycle.closeHint')

  return (
    <section
      className="rounded-lg border bg-card p-4"
      aria-label={t('patient.visits.lifecycle.title')}
      data-visit-lifecycle-actions=""
    >
      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">{t('patient.visits.lifecycle.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('patient.visits.lifecycle.hint')}</p>
        </div>

        {access.status === 'unavailable' ? (
          <Alert status="error">
            <AlertDescription>{t('patient.visits.lifecycle.permissionUnavailable')}</AlertDescription>
          </Alert>
        ) : null}

        {visit.status === 'planned' && visit.isConfirmed && access.canManage ? (
          <Alert status="warning" data-confirmation-reset-warning="">
            <AlertTitle>{t('patient.visits.lifecycle.confirmationResetTitle')}</AlertTitle>
            <AlertDescription>{t('patient.visits.lifecycle.confirmationReset')}</AlertDescription>
          </Alert>
        ) : null}

        {error && dialog.mode === 'closed' ? (
          <Alert status="error" data-visit-lifecycle-error="">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" aria-busy={isSubmitting}>
          {visit.status === 'planned' && availability.canClose ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
                disabled={isSubmitting}
                onClick={(event) => openActionDialog(
                  { mode: 'confirmation', confirmed: !visit.isConfirmed },
                  event.currentTarget,
                )}
              >
                {visit.isConfirmed
                  ? t('patient.visits.lifecycle.unconfirm')
                  : t('patient.visits.lifecycle.confirm')}
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-full sm:w-auto"
                disabled={!availability.canComplete || isSubmitting}
                onClick={(event) => openActionDialog(
                  { mode: 'status', status: 'completed' },
                  event.currentTarget,
                )}
              >
                {t('patient.visits.lifecycle.complete')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
                disabled={isSubmitting}
                onClick={(event) => openActionDialog(
                  { mode: 'status', status: 'cancelled' },
                  event.currentTarget,
                )}
              >
                {t('patient.visits.lifecycle.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
                disabled={!availability.canNoShow || isSubmitting}
                onClick={(event) => openActionDialog(
                  { mode: 'status', status: 'no_show' },
                  event.currentTarget,
                )}
              >
                {t('patient.visits.lifecycle.noShow')}
              </Button>
            </>
          ) : visit.status !== 'planned' && availability.canReopen ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={isSubmitting}
              onClick={(event) => openActionDialog(
                { mode: 'status', status: 'planned' },
                event.currentTarget,
              )}
            >
              {t('patient.visits.lifecycle.reopen')}
            </Button>
          ) : null}

          {availability.canChangeSettlement && visit.isSettled ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={isSubmitting}
              onClick={(event) => openActionDialog(
                { mode: 'settlement', isSettled: false },
                event.currentTarget,
              )}
            >
              {t('patient.visits.lifecycle.unsettle')}
            </Button>
          ) : availability.canChangeSettlement ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={isSubmitting}
              onClick={(event) => openActionDialog(
                { mode: 'settlement', isSettled: true },
                event.currentTarget,
              )}
            >
              {t('patient.visits.lifecycle.settle')}
            </Button>
          ) : null}
        </div>

        {visit.status === 'planned' && availability.canClose && !availability.canComplete ? (
          <p className="text-xs text-muted-foreground" data-lifecycle-before-start="">
            {t('patient.visits.lifecycle.afterStartOnly')}
          </p>
        ) : null}

        {access.status === 'ready' && !access.canManage ? (
          <p className="text-xs text-muted-foreground" data-lifecycle-read-only="">
            {t('patient.visits.lifecycle.managementReadOnly')}
          </p>
        ) : null}
        {access.status === 'ready' && !access.canSettle ? (
          <p className="text-xs text-muted-foreground" data-settlement-read-only="">
            {t('patient.visits.lifecycle.settlementReadOnly')}
          </p>
        ) : null}
        {visit.status !== 'planned' && access.status === 'ready' && !availability.canReopen ? (
          <p className="text-xs text-muted-foreground" data-reopen-read-only="">
            {t('patient.visits.lifecycle.reopenReadOnly')}
          </p>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      </div>

      <Dialog
        open={dialog.mode !== 'closed'}
        onOpenChange={(open) => {
          if (!open && !isSubmitting) {
            setDialog({ mode: 'closed' })
            setError(null)
          }
        }}
      >
        <DialogContent
          size="sm"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            openerRef.current?.focus()
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void submitDialog()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {dialog.mode === 'status' && dialog.status === 'planned' ? (
              <Alert status="warning">
                <AlertTitle>{t('patient.visits.lifecycle.reopenWarningTitle')}</AlertTitle>
                <AlertDescription>{t('patient.visits.lifecycle.reopenWarning')}</AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert status="error" data-visit-lifecycle-dialog-error="">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {dialogNeedsReason ? (
              <FormField
                id="patient-visit-lifecycle-reason"
                label={t('patient.visits.lifecycle.reason')}
                required
                error={reasonError ?? undefined}
                description={t('patient.visits.lifecycle.shortcutHint')}
                disabled={isSubmitting}
              >
                <Textarea
                  ref={reasonRef}
                  autoFocus
                  value={reason}
                  rows={4}
                  maxLength={2000}
                  required
                  onChange={(event) => {
                    setReason(event.target.value)
                    if (event.target.value.trim()) setReasonError(null)
                  }}
                  placeholder={t('patient.visits.lifecycle.reasonPlaceholder')}
                />
              </FormField>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('patient.visits.lifecycle.shortcutHint')}
              </p>
            )}
          </div>
          <DialogFooter layout="equal">
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => {
                setDialog({ mode: 'closed' })
                setError(null)
              }}
            >
              {t('patient.common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={isSubmitting}
              onClick={() => void submitDialog()}
            >
              {t('patient.visits.lifecycle.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export default VisitLifecycleActions
