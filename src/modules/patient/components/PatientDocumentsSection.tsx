"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Input } from '@open-mercato/ui/primitives/input'
import { FieldLabel, Label } from '@open-mercato/ui/primitives/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { apiCallOrThrow, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { loadDocumentOptions, resolveDocumentLabel } from './referencePickers'
import type { PatientDocumentLinkItem, PatientPagedResponse } from '../types'

/**
 * The patient card's documents tab.
 *
 * Three things this surface has to get right, all of them spec rules:
 *
 * 1. **A title the caller cannot read is absent, not redacted.** The API returns `null` for a
 *    document that fails the documents module's own access check, and this renders a neutral
 *    placeholder. Pinning a document is not a grant.
 * 2. **An unfinished creation is visible and resumable.** A `pending_create` link shows
 *    "Finish assignment" and "Abandon" instead of a link to an editor, because the document may
 *    not exist. Retrying reuses the ids the intent fixed, so it can never make a second one.
 * 3. **Sharing is stated before it happens.** The pin dialog says that access stays governed by
 *    the document's own owner/share policy, and that revoking the clinical feature later does
 *    not revoke an independent share. The spec requires the semantics be communicated rather
 *    than implied.
 *
 * Opening a linked document navigates to the NATIVE documents editor. This module does not
 * reimplement a document editor, and the native route enforces the document ACL on its own.
 */
export type PatientDocumentsSectionProps = {
  patientId: string
  /** An archived record accepts no new links; existing ones stay readable. */
  readOnly?: boolean
  onMutated?: () => void
}

type DialogState = { mode: 'closed' } | { mode: 'pin' } | { mode: 'create' }


export function PatientDocumentsSection({
  patientId,
  readOnly = false,
  onMutated,
}: PatientDocumentsSectionProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [dialog, setDialog] = React.useState<DialogState>({ mode: 'closed' })
  const [busyLinkId, setBusyLinkId] = React.useState<string | null>(null)

  const queryKey = React.useMemo(() => ['patient.documentLinks', patientId], [patientId])

  const { data, isLoading, error, refetch } = useQuery<PatientPagedResponse<PatientDocumentLinkItem>>({
    queryKey,
    queryFn: async () =>
      (await readApiResultOrThrow<PatientPagedResponse<PatientDocumentLinkItem>>(
        `/api/patient/document-links?patientId=${encodeURIComponent(patientId)}&pageSize=100`,
        undefined,
        { errorMessage: t('patient.patients.documents.error') },
      )) as PatientPagedResponse<PatientDocumentLinkItem>,
  })

  const refresh = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey })
    onMutated?.()
  }, [onMutated, queryClient, queryKey])

  const runLinkAction = React.useCallback(
    async (link: PatientDocumentLinkItem, action: 'resume' | 'abandon', successKey: string) => {
      setBusyLinkId(link.id)
      try {
        await withScopedApiRequestHeaders(buildOptimisticLockHeader(link.updatedAt), () =>
          apiCallOrThrow(`/api/patient/document-links/${encodeURIComponent(link.id)}/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedUpdatedAt: link.updatedAt }),
          }),
        )
        flash(t(successKey), 'success')
        refresh()
      } catch (err) {
        if (surfaceRecordConflict(err, t)) {
          refresh()
          return
        }
        flash(
          err instanceof Error && err.message ? err.message : t('patient.patients.documents.error'),
          'error',
        )
      } finally {
        setBusyLinkId(null)
      }
    },
    [refresh, t],
  )

  const items = data?.items ?? []
  // An abandoned intent is history, not a document of this patient. Keeping it in the list would
  // make a discarded attempt look like a pinned document.
  const visibleItems = items.filter((item) => item.state !== 'abandoned')

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
        title={t('patient.patients.documents.error')}
        description={error instanceof Error ? error.message : undefined}
        actions={<Button onClick={() => refetch()}>{t('patient.common.retry')}</Button>}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <SectionHeader
          title={t('patient.patients.tabs.documents')}
          count={visibleItems.length}
          action={
            readOnly ? undefined : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setDialog({ mode: 'pin' })}>
                  {t('patient.patients.documents.pin')}
                </Button>
                <Button onClick={() => setDialog({ mode: 'create' })}>
                  {t('patient.patients.documents.createNew')}
                </Button>
              </div>
            )
          }
        />
        <p className="text-sm text-muted-foreground">{t('patient.patients.documents.description')}</p>
      </div>

      {visibleItems.length === 0 ? (
        <EmptyState
          title={t('patient.patients.documents.empty.title')}
          description={t('patient.patients.documents.empty.body')}
          actions={
            readOnly ? undefined : (
              <Button onClick={() => setDialog({ mode: 'create' })}>
                {t('patient.patients.documents.createNew')}
              </Button>
            )
          }
        />
      ) : (
        <ul className="divide-y rounded-md border">
          {visibleItems.map((link) => {
            const isPending = link.state === 'pending_create'
            return (
              <li key={link.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {link.title ? (
                      <span className="font-medium">{link.title}</span>
                    ) : (
                      // Neutral placeholder rather than a redaction marker: the caller is not
                      // being told a secret exists, they simply cannot read this document.
                      <span className="font-medium text-muted-foreground">
                        {t('patient.patients.documents.titleUnavailable')}
                      </span>
                    )}
                    {isPending ? (
                      <StatusBadge variant="warning" appearance="light">
                        {t('patient.patients.documents.state.pending')}
                      </StatusBadge>
                    ) : null}
                    {link.isSharedWithOtherPatients ? (
                      <StatusBadge variant="info" appearance="light">
                        {t('patient.patients.documents.sharedBadge')}
                      </StatusBadge>
                    ) : null}
                  </div>
                  {isPending ? (
                    <p className="text-xs text-muted-foreground">
                      {t('patient.patients.documents.pendingHint')}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* A linked document opens in the NATIVE editor, which enforces the document
                      ACL itself. The link is offered only when the title resolved, because a
                      caller who cannot read the document has nothing to open. */}
                  {!isPending && link.title ? (
                    <Button asChild variant="outline">
                      <Link href={`/backend/documents/${link.documentId}`}>
                        {t('patient.patients.documents.open')}
                      </Link>
                    </Button>
                  ) : null}
                  {isPending && !readOnly ? (
                    <Button
                      variant="outline"
                      disabled={busyLinkId === link.id}
                      onClick={() =>
                        void runLinkAction(link, 'resume', 'patient.patients.documents.flash.resumed')
                      }
                    >
                      {t('patient.patients.documents.finish')}
                    </Button>
                  ) : null}
                  {readOnly ? null : (
                    <RowActions
                      items={
                        isPending
                          ? [
                              {
                                id: 'patient.documentLinks.abandon',
                                label: t('patient.patients.documents.abandon'),
                                destructive: true,
                                onSelect: async () => {
                                  const confirmed = await confirm({
                                    title: t('patient.patients.documents.confirmAbandon.title'),
                                    description: t('patient.patients.documents.confirmAbandon.body'),
                                    variant: 'destructive',
                                  })
                                  if (!confirmed) return
                                  await runLinkAction(
                                    link,
                                    'abandon',
                                    'patient.patients.documents.flash.abandoned',
                                  )
                                },
                              },
                            ]
                          : [
                              {
                                id: 'patient.documentLinks.unpin',
                                label: t('patient.patients.documents.unpin'),
                                destructive: true,
                                onSelect: async () => {
                                  const confirmed = await confirm({
                                    title: t('patient.patients.documents.confirmUnpin.title'),
                                    // Says the document itself is not deleted, and warns when it
                                    // is attached to another patient too.
                                    description: link.isSharedWithOtherPatients
                                      ? t('patient.patients.documents.confirmUnpin.bodyShared')
                                      : t('patient.patients.documents.confirmUnpin.body'),
                                    variant: 'destructive',
                                  })
                                  if (!confirmed) return
                                  setBusyLinkId(link.id)
                                  try {
                                    await withScopedApiRequestHeaders(
                                      buildOptimisticLockHeader(link.updatedAt),
                                      () =>
                                        apiCallOrThrow('/api/patient/document-links', {
                                          method: 'DELETE',
                                          headers: { 'content-type': 'application/json' },
                                          body: JSON.stringify({
                                            id: link.id,
                                            expectedUpdatedAt: link.updatedAt,
                                          }),
                                        }),
                                    )
                                    flash(t('patient.patients.documents.flash.unpinned'), 'success')
                                    refresh()
                                  } catch (err) {
                                    if (surfaceRecordConflict(err, t)) {
                                      refresh()
                                      return
                                    }
                                    flash(
                                      err instanceof Error && err.message
                                        ? err.message
                                        : t('patient.patients.documents.error'),
                                      'error',
                                    )
                                  } finally {
                                    setBusyLinkId(null)
                                  }
                                },
                              },
                            ]
                      }
                    />
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <DocumentDialog
        state={dialog}
        patientId={patientId}
        onClose={() => setDialog({ mode: 'closed' })}
        onSaved={() => {
          setDialog({ mode: 'closed' })
          refresh()
        }}
      />
      {ConfirmDialogElement}
    </div>
  )
}

/** Pin-existing and create-new dialog. */
function DocumentDialog({
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

  const [title, setTitle] = React.useState('')
  const [documentId, setDocumentId] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [clientRequestId, setClientRequestId] = React.useState('')

  React.useEffect(() => {
    if (!isOpen) return
    setFormError(null)
    setIsSubmitting(false)
    // One id per opened dialog: a double-clicked save resumes the same intent instead of
    // starting a second document.
    setClientRequestId(crypto.randomUUID())
    setTitle('')
    setDocumentId('')
  }, [isOpen])

  const canSubmit =
    !isSubmitting && (mode === 'create' ? title.trim().length > 0 : documentId.length > 0)

  const submit = React.useCallback(async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    setFormError(null)
    try {
      if (mode === 'create') {
        const call = await apiCallOrThrow<{ state?: string }>('/api/patient/document-links/new', {
          // optimistic-lock-exempt: creating an intent has no prior version.
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patientId, title: title.trim(), clientRequestId }),
        })
        // 202 means the intent is recorded but the document is not confirmed. Saying so is the
        // honest outcome — the list then offers "Finish assignment" rather than an editor link.
        flash(
          call.result?.state === 'pending_create'
            ? t('patient.patients.documents.flash.pending')
            : t('patient.patients.documents.flash.created'),
          call.result?.state === 'pending_create' ? 'info' : 'success',
        )
      } else {
        await apiCallOrThrow('/api/patient/document-links', {
          // optimistic-lock-exempt: create has no prior version.
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patientId, documentId, clientRequestId }),
        })
        flash(t('patient.patients.documents.flash.pinned'), 'success')
      }
      onSaved()
    } catch (err) {
      if (surfaceRecordConflict(err, t)) {
        onSaved()
        return
      }
      setFormError(
        err instanceof Error && err.message ? err.message : t('patient.patients.documents.error'),
      )
    } finally {
      setIsSubmitting(false)
    }
  }, [canSubmit, clientRequestId, documentId, mode, onSaved, patientId, t, title])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
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
              ? t('patient.patients.documents.createNew')
              : t('patient.patients.documents.pin')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? t('patient.patients.documents.createHint')
              : t('patient.patients.documents.pinHint')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {formError ? <Alert variant="destructive">{formError}</Alert> : null}

          {/* Stated before the action, per the spec: pinning does not grant access, and revoking
              the clinical feature later does not revoke an independent share. */}
          <Alert variant="info">{t('patient.patients.documents.aclNotice')}</Alert>

          {mode === 'create' ? (
            <div className="space-y-1">
              <FieldLabel htmlFor="patient-document-title" required>
                {t('patient.patients.documents.titleLabel')}
              </FieldLabel>
              <Input
                id="patient-document-title"
                value={title}
                maxLength={250}
                onChange={(event) => setTitle(event.target.value)}
                required
              />
            </div>
          ) : (
            <div className="space-y-2">
              <FieldLabel required>{t('patient.patients.documents.selectLabel')}</FieldLabel>
              {/* One searchable combobox, the same control the contact picker uses: the
                  operator types and chooses in one place instead of typing into a search box
                  above a separate select. `allowCustomValues` stays off, so the submitted
                  value is always a document id this caller can already see. */}
              <ComboboxInput
                value={documentId}
                onChange={(next: string | null) => setDocumentId(next ?? '')}
                placeholder={t('patient.patients.documents.searchLabel')}
                loadSuggestions={loadDocumentOptions}
                resolveLabel={resolveDocumentLabel}
                allowCustomValues={false}
                clearable
                clearLabel={t('patient.patients.documents.clearDocument')}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('patient.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {t('patient.patients.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default PatientDocumentsSection
