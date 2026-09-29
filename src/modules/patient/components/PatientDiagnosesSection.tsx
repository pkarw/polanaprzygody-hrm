"use client"
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Input } from '@open-mercato/ui/primitives/input'
import { FieldLabel, Label } from '@open-mercato/ui/primitives/label'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { apiCallOrThrow, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { PatientDiagnosisItem, PatientPagedResponse } from '../types'

/**
 * The patient card's diagnoses tab.
 *
 * The whole surface is built around one rule: a diagnosis is immutable. There is no edit action
 * and no delete action, because neither exists on the API. "Correct" opens a form pre-filled
 * with the current content and records a NEW entry superseding this one; "Void" withdraws an
 * entry with a required reason and keeps its text. Both the superseded and the voided entries
 * stay on screen, marked, so the history reads as what actually happened rather than as a
 * tidied-up final state.
 *
 * Only the latest active entry offers "Correct" — correcting mid-chain would fork the history,
 * and the server refuses it with a 409. Disabling the action is clearer than letting the
 * clinician discover that by failing.
 */
export type PatientDiagnosesSectionProps = {
  patientId: string
  /** An archived record accepts no NEW entry; corrections and voids stay available. */
  readOnly?: boolean
  onMutated?: () => void
}

type DialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'correct'; diagnosis: PatientDiagnosisItem }
  | { mode: 'void'; diagnosis: PatientDiagnosisItem }

export function PatientDiagnosesSection({
  patientId,
  readOnly = false,
  onMutated,
}: PatientDiagnosesSectionProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const [dialog, setDialog] = React.useState<DialogState>({ mode: 'closed' })

  const queryKey = React.useMemo(() => ['patient.diagnoses', patientId], [patientId])

  const { data, isLoading, error, refetch } = useQuery<PatientPagedResponse<PatientDiagnosisItem>>({
    queryKey,
    queryFn: async () =>
      (await readApiResultOrThrow<PatientPagedResponse<PatientDiagnosisItem>>(
        `/api/patient/diagnoses?patientId=${encodeURIComponent(patientId)}&pageSize=100`,
        undefined,
        { errorMessage: t('patient.patients.diagnoses.error') },
      )) as PatientPagedResponse<PatientDiagnosisItem>,
  })

  const refresh = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey })
    onMutated?.()
  }, [onMutated, queryClient, queryKey])

  const items = data?.items ?? []

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" aria-live="polite">
        <Spinner className="size-4" />
        {t('patient.common.loading')}
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        title={t('patient.patients.diagnoses.error')}
        description={error instanceof Error ? error.message : undefined}
        actions={<Button onClick={() => refetch()}>{t('patient.common.retry')}</Button>}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <SectionHeader
          title={t('patient.patients.tabs.diagnoses')}
          count={items.length}
          action={
            readOnly ? undefined : (
              <Button onClick={() => setDialog({ mode: 'create' })}>
                {t('patient.patients.diagnoses.add')}
              </Button>
            )
          }
        />
        <p className="text-sm text-muted-foreground">{t('patient.patients.diagnoses.description')}</p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={t('patient.patients.diagnoses.empty.title')}
          description={t('patient.patients.diagnoses.empty.body')}
          actions={
            readOnly ? undefined : (
              <Button onClick={() => setDialog({ mode: 'create' })}>
                {t('patient.patients.diagnoses.add')}
              </Button>
            )
          }
        />
      ) : (
        <ul className="space-y-3">
          {items.map((diagnosis) => (
            <li key={diagnosis.id} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{diagnosis.title}</span>
                    <DiagnosisStatusBadge status={diagnosis.status} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('patient.patients.diagnoses.meta', {
                      date: diagnosis.diagnosedOn,
                      author: diagnosis.author?.name ?? t('patient.common.unavailableReference'),
                    })}
                  </p>
                  {diagnosis.code && diagnosis.codeSystem ? (
                    <p className="text-xs text-muted-foreground">
                      {diagnosis.codeSystem}
                      {diagnosis.codeVersion ? ` ${diagnosis.codeVersion}` : ''}: {diagnosis.code}
                    </p>
                  ) : null}
                </div>
                <RowActions
                  items={[
                    // Correcting is offered only for the latest active entry. The server refuses
                    // anything else with a 409; disabling it here explains why instead.
                    ...(readOnly || diagnosis.status !== 'active'
                      ? []
                      : [
                          {
                            id: 'patient.diagnoses.correct',
                            label: t('patient.patients.diagnoses.correct'),
                            onSelect: () => setDialog({ mode: 'correct', diagnosis }),
                          },
                        ]),
                    // Voiding stays available on an archived record: it repairs history rather
                    // than adding to it, which is the spec's distinction.
                    ...(diagnosis.status === 'voided'
                      ? []
                      : [
                          {
                            id: 'patient.diagnoses.void',
                            label: t('patient.patients.diagnoses.void'),
                            destructive: true,
                            onSelect: () => setDialog({ mode: 'void', diagnosis }),
                          },
                        ]),
                  ]}
                />
              </div>

              {/* The description is shown in full rather than truncated: a clinician reading a
                  history should not have to expand each entry to see what it says. */}
              <p className="whitespace-pre-wrap text-sm">{diagnosis.description}</p>

              {diagnosis.status === 'voided' && diagnosis.voidReason ? (
                <Alert variant="warning">
                  {t('patient.patients.diagnoses.voidedWith', { reason: diagnosis.voidReason })}
                </Alert>
              ) : null}
              {diagnosis.status === 'superseded' ? (
                // Tells the reader the entry was corrected, so an old entry is never mistaken
                // for the current one.
                <p className="text-xs text-muted-foreground">
                  {t('patient.patients.diagnoses.supersededNotice')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <DiagnosisDialog
        state={dialog}
        patientId={patientId}
        onClose={() => setDialog({ mode: 'closed' })}
        onSaved={() => {
          setDialog({ mode: 'closed' })
          refresh()
        }}
      />
    </div>
  )
}

function DiagnosisStatusBadge({ status }: { status: PatientDiagnosisItem['status'] }) {
  const t = useT()
  // Semantic variants, never hard-coded colours: active is the current entry, superseded is
  // historical, voided is withdrawn.
  const variant = status === 'active' ? 'success' : status === 'superseded' ? 'neutral' : 'warning'
  return (
    <StatusBadge variant={variant} appearance="light">
      {t(`patient.patients.diagnoses.status.${status}`)}
    </StatusBadge>
  )
}

/**
 * Create / correct / void dialog.
 *
 * Correct is pre-filled with the entry's current content, because a correction is usually a
 * small edit to a long description and retyping it invites losing detail. Void asks only for a
 * reason — it never touches the text.
 */
function DiagnosisDialog({
  state,
  patientId,
  onClose,
  onSaved,
}: {
  state: DialogState
  patientId: string
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const isOpen = state.mode !== 'closed'
  const mode = state.mode
  const source = state.mode === 'correct' || state.mode === 'void' ? state.diagnosis : null

  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [diagnosedOn, setDiagnosedOn] = React.useState('')
  const [code, setCode] = React.useState('')
  const [codeSystem, setCodeSystem] = React.useState('')
  const [codeVersion, setCodeVersion] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  /**
   * One request id per opened dialog, so a double-clicked save or a retry after a network error
   * that actually committed resolves to the SAME entry instead of a duplicate.
   */
  const [clientRequestId, setClientRequestId] = React.useState('')

  const todayIso = React.useMemo(() => {
    // Local date, matching the server's organization-local comparison. A UTC date here would
    // show "tomorrow" as the default just after local midnight.
    const now = new Date()
    const offset = now.getTimezoneOffset() * 60_000
    return new Date(now.getTime() - offset).toISOString().slice(0, 10)
  }, [])

  React.useEffect(() => {
    if (!isOpen) return
    setFormError(null)
    setIsSubmitting(false)
    setClientRequestId(crypto.randomUUID())
    setReason('')
    if (source) {
      setTitle(source.title)
      setDescription(source.description)
      setDiagnosedOn(source.diagnosedOn)
      setCode(source.code ?? '')
      setCodeSystem(source.codeSystem ?? '')
      setCodeVersion(source.codeVersion ?? '')
    } else {
      setTitle('')
      setDescription('')
      setDiagnosedOn(todayIso)
      setCode('')
      setCodeSystem('')
      setCodeVersion('')
    }
  }, [isOpen, source, todayIso])

  // A code and its system are set together or not at all — the same pair rule the server applies.
  const codePairIsConsistent = (code.trim().length > 0) === (codeSystem.trim().length > 0)
  const contentIsComplete =
    title.trim().length > 0 && description.trim().length > 0 && diagnosedOn.length > 0 && codePairIsConsistent
  const canSubmit = !isSubmitting && (mode === 'void' ? reason.trim().length > 0 : contentIsComplete)

  const submit = React.useCallback(async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    setFormError(null)
    const content = {
      title: title.trim(),
      description: description.trim(),
      diagnosedOn,
      code: code.trim().length > 0 ? code.trim() : null,
      codeSystem: codeSystem.trim().length > 0 ? codeSystem.trim() : null,
      codeVersion: codeVersion.trim().length > 0 ? codeVersion.trim() : null,
    }
    try {
      if (mode === 'create') {
        await apiCallOrThrow('/api/patient/diagnoses', {
          // optimistic-lock-exempt: a new entry has no prior version.
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patientId, ...content, clientRequestId }),
        })
        flash(t('patient.patients.diagnoses.flash.created'), 'success')
      } else if (mode === 'correct' && source) {
        await withScopedApiRequestHeaders(buildOptimisticLockHeader(source.updatedAt), () =>
          apiCallOrThrow(`/api/patient/diagnoses/${encodeURIComponent(source.id)}/correct`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...content, expectedUpdatedAt: source.updatedAt, clientRequestId }),
          }),
        )
        flash(t('patient.patients.diagnoses.flash.corrected'), 'success')
      } else if (mode === 'void' && source) {
        await withScopedApiRequestHeaders(buildOptimisticLockHeader(source.updatedAt), () =>
          apiCallOrThrow(`/api/patient/diagnoses/${encodeURIComponent(source.id)}/void`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: reason.trim(), expectedUpdatedAt: source.updatedAt }),
          }),
        )
        flash(t('patient.patients.diagnoses.flash.voided'), 'success')
      }
      onSaved()
    } catch (err) {
      if (surfaceRecordConflict(err, t)) {
        onSaved()
        return
      }
      // Kept in the dialog with the clinician's text intact. Closing on error would discard a
      // description that can be thousands of characters long.
      setFormError(err instanceof Error && err.message ? err.message : t('patient.patients.diagnoses.error'))
    } finally {
      setIsSubmitting(false)
    }
  }, [
    canSubmit,
    clientRequestId,
    code,
    codeSystem,
    codeVersion,
    description,
    diagnosedOn,
    mode,
    onSaved,
    patientId,
    reason,
    source,
    t,
    title,
  ])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      {/* No height or overflow class here: `DialogContent` already caps itself at 90vh and
          scrolls, so adding an arbitrary value would duplicate that and bypass the DS scale. */}
      <DialogContent
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? t('patient.patients.diagnoses.add')
              : mode === 'correct'
                ? t('patient.patients.diagnoses.correct')
                : t('patient.patients.diagnoses.void')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'correct'
              ? t('patient.patients.diagnoses.correctHint')
              : mode === 'void'
                ? t('patient.patients.diagnoses.voidHint')
                : t('patient.patients.diagnoses.createHint')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {formError ? <Alert variant="destructive">{formError}</Alert> : null}

          {mode === 'void' ? (
            <div className="space-y-1">
              <FieldLabel htmlFor="patient-diagnosis-reason" required>
                {t('patient.patients.diagnoses.reason')}
              </FieldLabel>
              <Textarea
                id="patient-diagnosis-reason"
                value={reason}
                rows={3}
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('patient.patients.diagnoses.reasonPlaceholder')}
                required
              />
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <FieldLabel htmlFor="patient-diagnosis-title" required>
                  {t('patient.patients.diagnoses.title')}
                </FieldLabel>
                <Input
                  id="patient-diagnosis-title"
                  value={title}
                  maxLength={250}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <FieldLabel htmlFor="patient-diagnosis-date" required>
                  {t('patient.patients.diagnoses.date')}
                </FieldLabel>
                <Input
                  id="patient-diagnosis-date"
                  type="date"
                  value={diagnosedOn}
                  // A historical date is legitimate; a future one is not, and the server
                  // enforces the same bound against the organization's local day.
                  max={todayIso}
                  onChange={(event) => setDiagnosedOn(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <FieldLabel htmlFor="patient-diagnosis-description" required>
                  {t('patient.patients.diagnoses.descriptionLabel')}
                </FieldLabel>
                <Textarea
                  id="patient-diagnosis-description"
                  value={description}
                  rows={8}
                  maxLength={50_000}
                  onChange={(event) => setDescription(event.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="patient-diagnosis-code-system">
                    {t('patient.patients.diagnoses.codeSystem')}
                  </Label>
                  <Input
                    id="patient-diagnosis-code-system"
                    value={codeSystem}
                    maxLength={100}
                    onChange={(event) => setCodeSystem(event.target.value)}
                    placeholder={t('patient.patients.diagnoses.codeSystemPlaceholder')}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="patient-diagnosis-code">{t('patient.patients.diagnoses.code')}</Label>
                  <Input
                    id="patient-diagnosis-code"
                    value={code}
                    maxLength={100}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="patient-diagnosis-code-version">
                    {t('patient.patients.diagnoses.codeVersion')}
                  </Label>
                  <Input
                    id="patient-diagnosis-code-version"
                    value={codeVersion}
                    maxLength={50}
                    onChange={(event) => setCodeVersion(event.target.value)}
                  />
                </div>
              </div>
              {!codePairIsConsistent ? (
                <p className="text-xs text-destructive" role="alert">
                  {t('patient.patients.diagnoses.codePairRequired')}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('patient.patients.diagnoses.codeOptionalHint')}
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('patient.common.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            variant={mode === 'void' ? 'destructive' : 'default'}
          >
            {mode === 'void'
              ? t('patient.patients.diagnoses.void')
              : t('patient.patients.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default PatientDiagnosesSection
