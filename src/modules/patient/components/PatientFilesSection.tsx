"use client"
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { apiCallOrThrow, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { PatientAttachmentLinkItem, PatientPagedResponse } from '../types'
import { useClinicalFilesAvailability } from './useClinicalFilesAvailability'

/**
 * The patient card's clinical files tab.
 *
 * On this installation the tab exists but cannot store files: the installed attachments module
 * authorizes downloads by tenant and organization scope alone, so a "private" clinical file would
 * be readable by any signed-in user of the organization who knows its id. The banner says exactly
 * that, in the operator's language, instead of presenting upload controls that fail.
 *
 * Why show the tab at all rather than hide it: an operator looking for the files feature needs to
 * find out *why* it is absent, and a deployment that has already stored links on a previously
 * enabled host must still be able to see and detach them. Hiding the tab would make both
 * invisible.
 *
 * Detaching stays available even while attaching is refused — removing a link can only narrow
 * exposure.
 */
export type PatientFilesSectionProps = {
  patientId: string
  readOnly?: boolean
  onMutated?: () => void
}

export function PatientFilesSection({ patientId, readOnly = false, onMutated }: PatientFilesSectionProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const availability = useClinicalFilesAvailability()

  const queryKey = React.useMemo(() => ['patient.attachmentLinks', patientId], [patientId])

  const { data, isLoading, error, refetch } = useQuery<PatientPagedResponse<PatientAttachmentLinkItem>>({
    queryKey,
    queryFn: async () =>
      (await readApiResultOrThrow<PatientPagedResponse<PatientAttachmentLinkItem>>(
        `/api/patient/attachment-links?patientId=${encodeURIComponent(patientId)}&pageSize=100`,
        undefined,
        { errorMessage: t('patient.patients.files.error') },
      )) as PatientPagedResponse<PatientAttachmentLinkItem>,
  })

  const refresh = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey })
    onMutated?.()
  }, [onMutated, queryClient, queryKey])

  const items = (data?.items ?? []).filter((item) => item.state === 'active')
  const canAttach = availability === 'available' && !readOnly

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <SectionHeader title={t('patient.patients.tabs.files')} count={items.length} />
        <p className="text-sm text-muted-foreground">{t('patient.patients.files.description')}</p>
      </div>

      {availability === 'unavailable' ? (
        // `warning`, not `destructive`: nothing has gone wrong with this record, a platform
        // capability is missing. The copy names the consequence and who can act on it.
        <Alert variant="warning">{t('patient.patients.files.unavailableNotice')}</Alert>
      ) : null}

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" aria-live="polite">
          <Spinner className="size-4" />
          {t('patient.common.loading')}
        </div>
      ) : error ? (
        <EmptyState
          title={t('patient.patients.files.error')}
          description={error instanceof Error ? error.message : undefined}
          actions={<Button onClick={() => refetch()}>{t('patient.common.retry')}</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('patient.patients.files.empty.title')}
          description={
            availability === 'unavailable'
              ? t('patient.patients.files.empty.bodyUnavailable')
              : t('patient.patients.files.empty.body')
          }
          // No upload action offered while the gate is closed: an action that always fails is
          // worse than no action, and the banner above already explains why.
          actions={canAttach ? <Button disabled>{t('patient.patients.files.attach')}</Button> : undefined}
        />
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((link) => (
            <li key={link.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
              <div className="min-w-0 space-y-1">
                <span className="font-medium">
                  {link.fileName ?? t('patient.patients.files.unnamed')}
                </span>
                {/* The source is marked, because the spec requires the card to show both a
                    patient's general files and a diagnosis entry's files together. */}
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge variant="neutral" appearance="light">
                    {link.diagnosisId
                      ? t('patient.patients.files.source.diagnosis')
                      : t('patient.patients.files.source.patient')}
                  </StatusBadge>
                </div>
              </div>
              {readOnly ? null : (
                <RowActions
                  items={[
                    {
                      id: 'patient.attachmentLinks.detach',
                      label: t('patient.patients.files.detach'),
                      destructive: true,
                      onSelect: async () => {
                        const confirmed = await confirm({
                          title: t('patient.patients.files.confirmDetach.title'),
                          description: t('patient.patients.files.confirmDetach.body'),
                          variant: 'destructive',
                        })
                        if (!confirmed) return
                        try {
                          await withScopedApiRequestHeaders(
                            buildOptimisticLockHeader(link.updatedAt),
                            () =>
                              apiCallOrThrow('/api/patient/attachment-links', {
                                method: 'DELETE',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({
                                  id: link.id,
                                  expectedUpdatedAt: link.updatedAt,
                                }),
                              }),
                          )
                          flash(t('patient.patients.files.flash.detached'), 'success')
                          refresh()
                        } catch (err) {
                          if (surfaceRecordConflict(err, t)) {
                            refresh()
                            return
                          }
                          flash(
                            err instanceof Error && err.message
                              ? err.message
                              : t('patient.patients.files.error'),
                            'error',
                          )
                        }
                      },
                    },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {ConfirmDialogElement}
    </div>
  )
}

export default PatientFilesSection
