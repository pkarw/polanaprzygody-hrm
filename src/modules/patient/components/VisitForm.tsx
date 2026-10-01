"use client"
import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { CrudForm, type CrudField, type CrudFieldOption, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { createCrud, deleteCrud, fetchCrudList, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { ErrorMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { DatePicker } from '@open-mercato/ui/primitives/date-picker'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { format } from 'date-fns/format'
import extensionPoints from '../extension-points'
import type { PatientPagedResponse, PatientVisitItem } from '../types'
import {
  loadPatientOptions,
  loadResourceOptions,
  resolvePatientLabel,
  resolveResourceLabel,
} from './referencePickers'
import { VisitServicesField, type VisitServiceSeed } from './VisitServicesField'
import { VisitTeamMemberField } from './VisitTeamMemberField'
import { VisitLifecycleActions } from './VisitLifecycleActions'
import { VisitPaymentSection } from './VisitPaymentSection'
import { OnlineBookingProvenance } from './OnlineBookingProvenance'
import {
  VisitAvailabilityCheck,
  type VisitAvailabilityGateValue,
} from './VisitAvailabilityCheck'
import { usePatientVisitAccess } from './usePatientVisitAccess'
import {
  defaultVisitTimeZone,
  buildVisitSchedule,
  toVisitLocalDateTime,
} from '../lib/visitDateTime'
import {
  formatVisitConflictRejection,
  readVisitConflictRejection,
} from '../lib/visitLifecycleUi'

/**
 * Turns a 422 conflict rejection into a localized, itemized form error.
 *
 * The server re-evaluates conflicts under the slot lock, so a save can be refused even when the
 * availability check came back clean — or, on the degraded path, never ran at all. Without this
 * the operator sees the raw token (`visit_conflict_unacknowledged`): `raiseCrudError` puts it in
 * `Error.message` and `CrudForm` renders it through `t(msg, msg)`, where it is not a key. The
 * `conflicts` array riding on the same error is the only record of what actually clashed, and
 * the spec requires it to be shown again.
 */
async function withVisitConflictErrors(
  save: () => Promise<unknown>,
  t: (key: string, fallback?: string) => string,
): Promise<void> {
  try {
    await save()
  } catch (error) {
    const rejection = readVisitConflictRejection(error)
    if (!rejection) throw error
    throw createCrudFormError(formatVisitConflictRejection(rejection, t), undefined, {
      status: 422,
      details: rejection.conflicts,
    })
  }
}

const LIST_HREF = '/backend/patient/visits'
const ENTITY_ID = extensionPoints.hosts.visitForm.entityId.replace('.', ':')

type VisitFormValues = {
  id?: string
  patientId: string
  teamMemberId: string
  resourceId: string | null
  startsAtLocal: string
  endsAtLocal: string | null
  timeZone: string
  description: string | null
  serviceProductIds: string[]
  availabilityGate: VisitAvailabilityGateValue | null
  updatedAt?: string
}

export type VisitEditorSeed = {
  patientId?: string
  teamMemberId?: string
  resourceId?: string | null
  startsAt?: string | Date
  endsAt?: string | Date | null
  timeZone?: string
}

export type VisitCalendarDialogState =
  | { mode: 'create'; seed?: VisitEditorSeed }
  | { mode: 'edit'; visitId: string }

type EmbeddedVisitFormProps = {
  embedded?: boolean
  onSaved?: () => void | Promise<void>
  onChanged?: () => void | Promise<void>
  seed?: VisitEditorSeed
}

function orNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function timeZoneOptions(query?: string): Promise<CrudFieldOption[]> {
  const runtimeZones = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] })
    .supportedValuesOf?.('timeZone') ?? ['Europe/Warsaw']
  const supported = Array.from(new Set(['UTC', ...runtimeZones]))
  const needle = query?.trim().toLocaleLowerCase() ?? ''
  return Promise.resolve(supported
    .filter((zone) => !needle || zone.toLocaleLowerCase().includes(needle))
    .slice(0, 100)
    .map((zone) => ({ value: zone, label: zone })))
}

function accessibleDateTimeField(input: {
  id: 'startsAtLocal' | 'endsAtLocal'
  label: string
  required?: boolean
}): CrudField {
  return {
    id: input.id,
    label: '',
    type: 'custom',
    required: input.required,
    rendersOwnError: true,
    component: ({ value, setValue, error, disabled }) => (
      <FormField
        id={`patient-visit-${input.id}`}
        label={input.label}
        required={input.required}
        error={error}
        disabled={disabled}
      >
        <DatePicker
          withTime
          minuteStep={5}
          value={typeof value === 'string' && value ? new Date(value) : null}
          onChange={(date) => setValue(date ? format(date, "yyyy-MM-dd'T'HH:mm") : null)}
        />
      </FormField>
    ),
  }
}

function accessibleDescriptionField(input: {
  label: string
  description: string
}): CrudField {
  const maxLength = 20_000
  return {
    id: 'description',
    label: '',
    type: 'custom',
    rendersOwnError: true,
    component: ({ value, setValue, error, autoFocus, disabled }) => {
      const text = typeof value === 'string' ? value : ''
      return (
        <div className="space-y-1">
          <FormField
            id="patient-visit-description"
            label={input.label}
            description={input.description}
            error={error}
            disabled={disabled}
          >
            <Textarea
              value={text}
              rows={5}
              maxLength={maxLength}
              autoFocus={autoFocus}
              onChange={(event) => setValue(event.target.value)}
            />
          </FormField>
          <p className="text-right text-xs text-muted-foreground" aria-live="polite">
            {text.length}/{maxLength}
          </p>
        </div>
      )
    },
  }
}

function useVisitFields(
  seedServices: VisitServiceSeed[] = [],
  patientReadOnly = false,
  referenceSeeds?: {
    teamMember?: CrudFieldOption
    resource?: CrudFieldOption
  },
  excludeVisitId?: string,
): CrudField[] {
  const t = useT()
  return React.useMemo<CrudField[]>(() => [
    {
      id: 'patientId',
      label: t('patient.visits.fields.patient'),
      type: 'combobox',
      required: true,
      disabled: patientReadOnly,
      loadOptions: loadPatientOptions,
      resolveLabel: resolvePatientLabel,
    },
    {
      id: 'teamMemberId',
      // `label: ''` plus a `FormField` wrapper, the same pattern as the date-time and
      // description fields above. `CrudForm` renders a custom field's label as a bare
      // `<label>` with no `htmlFor`, so the built-in label is not programmatically associated
      // and a screen reader announces this required combobox as "combobox, blank" — on the
      // field that decides whose calendar gets booked.
      label: '',
      type: 'custom',
      required: true,
      rendersOwnError: true,
      component: ({ value, setValue, error, disabled, values }) => (
        <FormField
          id="patient-visit-teamMemberId"
          label={t('patient.visits.fields.teamMember')}
          required
          error={error}
          disabled={disabled}
        >
          <VisitTeamMemberField
            value={typeof value === 'string' ? value : ''}
            onChange={(next) => setValue(next)}
            patientId={typeof values?.patientId === 'string' ? values.patientId : undefined}
            disabled={disabled}
            historicalOption={referenceSeeds?.teamMember}
          />
        </FormField>
      ),
    },
    {
      id: 'resourceId',
      label: t('patient.visits.fields.resource'),
      type: 'combobox',
      loadOptions: loadResourceOptions,
      resolveLabel: resolveResourceLabel,
      seedOptions: referenceSeeds?.resource ? [referenceSeeds.resource] : undefined,
      description: t('patient.visits.fields.resourceHint'),
    },
    accessibleDateTimeField({
      id: 'startsAtLocal',
      label: t('patient.visits.fields.startsAt'),
      required: true,
    }),
    accessibleDateTimeField({
      id: 'endsAtLocal',
      label: t('patient.visits.fields.endsAt'),
    }),
    {
      id: 'timeZone',
      label: t('patient.visits.fields.timeZone'),
      type: 'combobox',
      required: true,
      loadOptions: timeZoneOptions,
      allowCustomValues: false,
      description: t('patient.visits.fields.timeZoneHint'),
    },
    {
      id: 'availabilityGate',
      label: '',
      type: 'custom',
      required: true,
      rendersOwnError: true,
      component: ({ value, values, setValue, error, disabled }) => (
        <VisitAvailabilityCheck
          value={value}
          values={values}
          setValue={setValue}
          error={error}
          disabled={disabled}
          excludeVisitId={excludeVisitId}
        />
      ),
    },
    {
      id: 'serviceProductIds',
      label: '',
      type: 'custom',
      rendersOwnError: true,
      component: ({ value, setValue, error, disabled }) => (
        // No visible label here: the `services` group title already reads "Usługi"
        // directly above this field, so a FormField label would repeat it.
        <FormField
          id="patient-visit-serviceProductIds"
          error={error}
          disabled={disabled}
        >
          <VisitServicesField
            value={Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []}
            onChange={setValue}
            disabled={disabled}
            seedServices={seedServices}
          />
        </FormField>
      ),
    },
    accessibleDescriptionField({
      label: t('patient.visits.fields.description'),
      description: t('patient.visits.fields.descriptionHint'),
    }),
  ], [excludeVisitId, patientReadOnly, referenceSeeds?.resource, referenceSeeds?.teamMember, seedServices, t])
}

function useVisitGroups(): CrudFormGroup[] {
  const t = useT()
  return React.useMemo(() => [
    { id: 'patient', title: t('patient.visits.groups.patient'), column: 1, fields: ['patientId', 'teamMemberId', 'resourceId'] },
    { id: 'schedule', title: t('patient.visits.groups.schedule'), column: 2, fields: ['startsAtLocal', 'endsAtLocal', 'timeZone', 'availabilityGate'] },
    { id: 'services', title: t('patient.visits.groups.services'), column: 1, fields: ['serviceProductIds'] },
    { id: 'description', title: t('patient.visits.groups.description'), column: 2, fields: ['description'] },
  ], [t])
}

function buildSchedule(values: VisitFormValues, t: ReturnType<typeof useT>) {
  return buildVisitSchedule(values, {
    gap: t('patient.visits.validation.dstGap'),
    endAfterStart: t('patient.visits.validation.endAfterStart'),
  })
}

function seedInstant(value: string | Date | null | undefined): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

export function VisitCreateForm({
  embedded = false,
  onSaved,
  seed,
}: EmbeddedVisitFormProps = {}) {
  const t = useT()
  const searchParams = useSearchParams()
  const suggestedPatientId = seed?.patientId ?? searchParams.get('patientId') ?? ''
  const fields = useVisitFields()
  const groups = useVisitGroups()
  const clientRequestId = React.useMemo(() => crypto.randomUUID(), [])
  const initialValues = React.useMemo<Partial<VisitFormValues>>(() => {
    const timeZone = seed?.timeZone ?? defaultVisitTimeZone()
    const startsAt = seedInstant(seed?.startsAt)
    const endsAt = seedInstant(seed?.endsAt)
    return ({
    patientId: suggestedPatientId,
    teamMemberId: seed?.teamMemberId ?? '',
    resourceId: seed?.resourceId ?? null,
    startsAtLocal: startsAt ? toVisitLocalDateTime(startsAt, timeZone) : '',
    endsAtLocal: endsAt ? toVisitLocalDateTime(endsAt, timeZone) : null,
    timeZone,
    description: null,
    serviceProductIds: [],
    availabilityGate: { allowSubmit: true },
    })
  }, [seed, suggestedPatientId])

  return (
    <CrudForm<VisitFormValues>
      title={embedded ? undefined : t('patient.visits.create.title')}
      titleHeadingLevel={embedded ? 2 : 1}
      backHref={embedded ? undefined : LIST_HREF}
      entityId={ENTITY_ID}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={t('patient.visits.actions.save')}
      embedded={embedded}
      trackDirtyWhenEmbedded={embedded}
      customFieldsManageMode={embedded ? 'page' : 'inline'}
      cancelHref={embedded ? undefined : LIST_HREF}
      successRedirect={embedded ? undefined : `${LIST_HREF}?flash=${encodeURIComponent(t('patient.visits.flash.created'))}&type=success`}
      onSubmit={async (values) => {
        const schedule = buildSchedule(values, t)
        await withVisitConflictErrors(() => createCrud('patient/visits', {
          patientId: values.patientId,
          teamMemberId: values.teamMemberId,
          resourceId: orNull(values.resourceId),
          ...schedule,
          timeZone: values.timeZone,
          description: orNull(values.description),
          serviceProductIds: values.serviceProductIds,
          clientRequestId,
          ...(values.availabilityGate?.conflictOverride
            ? { conflictOverride: values.availabilityGate.conflictOverride }
            : {}),
        }), t)
        if (embedded) flash(t('patient.visits.flash.created'), 'success')
        await onSaved?.()
      }}
    />
  )
}

function toEditValues(record: PatientVisitItem): VisitFormValues {
  return {
    id: record.id,
    patientId: record.patientId,
    teamMemberId: record.teamMemberId,
    resourceId: record.resourceId,
    startsAtLocal: toVisitLocalDateTime(record.startsAt, record.timeZone),
    endsAtLocal: record.endsAt ? toVisitLocalDateTime(record.endsAt, record.timeZone) : null,
    timeZone: record.timeZone,
    description: record.description ?? null,
    serviceProductIds: record.services.map((service) => service.productId),
    availabilityGate: { allowSubmit: true },
    updatedAt: record.updatedAt,
  }
}

function VisitConflictOverrideAudit({ visit }: { visit: PatientVisitItem }) {
  const t = useT()
  if (!visit.conflictOverrideAt || !visit.conflictOverrideCodes?.length) return null
  const when = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(visit.conflictOverrideAt))
  return (
    <Alert status="warning" data-visit-conflict-override-audit>
      <AlertTitle>{t('patient.visits.conflicts.auditTitle')}</AlertTitle>
      <AlertDescription className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {visit.conflictOverrideCodes.map((code) => (
            <StatusBadge key={code} variant="warning" appearance="light">
              {t(`patient.visits.conflicts.code.${code}`)}
            </StatusBadge>
          ))}
        </div>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <dt className="font-medium">{t('patient.visits.conflicts.auditBy')}</dt>
          <dd>{visit.conflictOverrideByUserName ?? t('patient.visits.conflicts.auditUnknownUser')}</dd>
          <dt className="font-medium">{t('patient.visits.conflicts.auditAt')}</dt>
          <dd>{when}</dd>
          <dt className="font-medium">{t('patient.visits.conflicts.auditReason')}</dt>
          <dd className="whitespace-pre-wrap">{visit.conflictOverrideReason ?? t('patient.visits.conflicts.auditReasonUnavailable')}</dd>
        </dl>
      </AlertDescription>
    </Alert>
  )
}

export function VisitDetailForm({
  id,
  embedded = false,
  onSaved,
  onChanged,
}: { id: string } & EmbeddedVisitFormProps) {
  const t = useT()
  const access = usePatientVisitAccess()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [isDeleting, setIsDeleting] = React.useState(false)
  const query = useQuery<PatientPagedResponse<PatientVisitItem>>({
    queryKey: ['patient.visits', 'detail', id],
    queryFn: () => fetchCrudList<PatientVisitItem>('patient/visits', { id, pageSize: 1 }),
  })
  const record = query.data?.items?.[0]
  const seedServices = React.useMemo<VisitServiceSeed[]>(
    () => record?.services.map((service) => ({
      productId: service.productId,
      title: service.title,
      sku: service.sku,
      isAvailable: service.isAvailable,
    })) ?? [],
    [record?.services],
  )
  const referenceSeeds = React.useMemo(() => ({
    teamMember: record
      ? { value: record.teamMemberId, label: record.teamMemberName }
      : undefined,
    resource: record?.resourceId && record.resourceName
      ? { value: record.resourceId, label: record.resourceName }
      : undefined,
  }), [record])
  const fields = useVisitFields(seedServices, true, referenceSeeds, id)
  const groups = useVisitGroups()

  if (query.isLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center gap-2" role="status">
        <Spinner className="size-4" />
        <span>{t('patient.common.loading')}</span>
      </div>
    )
  }
  if (query.error) {
    return (
      <ErrorMessage
        label={query.error instanceof Error ? query.error.message : t('patient.common.error')}
        action={<Button variant="outline" onClick={() => void query.refetch()}>{t('patient.common.retry')}</Button>}
      />
    )
  }
  if (!record) {
    return (
      <RecordNotFoundState
        label={t('patient.visits.error.notFound')}
        backHref={LIST_HREF}
        backLabel={t('patient.visits.actions.backToList')}
      />
    )
  }

  const readOnly = record.status !== 'planned' || access.status !== 'ready' || !access.canManage
  const initialValues = toEditValues(record)
  return (
    <>
      <CrudForm<VisitFormValues>
      title={embedded ? undefined : t('patient.visits.detail.title')}
      titleHeadingLevel={embedded ? 2 : 1}
      backHref={embedded ? undefined : LIST_HREF}
      entityId={ENTITY_ID}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      disableInitialFocus
      embedded={embedded}
      trackDirtyWhenEmbedded={embedded}
      customFieldsManageMode={embedded ? 'page' : 'inline'}
      optimisticLockUpdatedAt={record.updatedAt}
      readOnly={readOnly}
      readOnlyOverlay={record.status !== 'planned'
        ? <p>{t('patient.visits.readOnly.closed')}</p>
        : access.status !== 'ready'
          ? <p>{t('patient.visits.readOnly.permissionUnavailable')}</p>
          : !access.canManage
            ? <p>{t('patient.visits.readOnly.noManage')}</p>
            : undefined}
      submitLabel={t('patient.visits.actions.save')}
      cancelHref={embedded ? undefined : LIST_HREF}
      successRedirect={embedded ? undefined : `${LIST_HREF}?flash=${encodeURIComponent(t('patient.visits.flash.updated'))}&type=success`}
      deleteRedirect={embedded ? undefined : `${LIST_HREF}?flash=${encodeURIComponent(t('patient.visits.flash.deleted'))}&type=success`}
      deleteVisible={!readOnly && !record.isSettled}
      contentHeader={(
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <StatusBadge
              variant={record.status === 'planned'
                ? 'info'
                : record.status === 'completed'
                  ? 'success'
                  : record.status === 'no_show'
                    ? 'warning'
                    : 'neutral'}
              dot
            >
              {t(`patient.visits.status.${record.status}`)}
            </StatusBadge>
            <StatusBadge variant={record.isConfirmed ? 'success' : 'warning'} appearance="light">
              {record.isConfirmed ? t('patient.visits.confirmation.confirmed') : t('patient.visits.confirmation.unconfirmed')}
            </StatusBadge>
            <StatusBadge variant={record.isSettled ? 'success' : 'neutral'} appearance="light">
              {record.isSettled ? t('patient.visits.settlement.settled') : t('patient.visits.settlement.unsettled')}
            </StatusBadge>
            {embedded && !readOnly && !record.isSettled ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isDeleting}
                data-visit-dialog-delete=""
                onClick={async () => {
                  const approved = await confirm({
                    title: t('patient.visits.confirm.delete.title'),
                    description: t('patient.visits.confirm.delete.body'),
                    variant: 'destructive',
                  })
                  if (!approved) return
                  setIsDeleting(true)
                  try {
                    await withScopedApiRequestHeaders(
                      buildOptimisticLockHeader(record.updatedAt),
                      () => deleteCrud('patient/visits', record.id),
                    )
                    flash(t('patient.visits.flash.deleted'), 'success')
                    await onSaved?.()
                  } catch (error) {
                    if (!surfaceRecordConflict(error, t, { onRefresh: () => { void query.refetch() } })) {
                      flash(error instanceof Error ? error.message : t('patient.errors.unexpected'), 'error')
                    }
                  } finally {
                    setIsDeleting(false)
                  }
                }}
              >
                {t('patient.visits.actions.delete')}
              </Button>
            ) : null}
          </div>
          <VisitConflictOverrideAudit visit={record} />
          <OnlineBookingProvenance visitId={record.id} access={access} />
          <VisitLifecycleActions
            visit={record}
            access={access}
            onSaved={async () => {
              await query.refetch()
              await onChanged?.()
            }}
          />
          <VisitPaymentSection
            visit={record}
            access={access}
            onSaved={async () => {
              await query.refetch()
              await onChanged?.()
            }}
          />
        </div>
      )}
      onSubmit={async (values) => {
        const schedule = buildSchedule(values, t)
        await withVisitConflictErrors(() => updateCrud('patient/visits', {
          id: record.id,
          expectedUpdatedAt: values.updatedAt ?? record.updatedAt,
          teamMemberId: values.teamMemberId,
          resourceId: orNull(values.resourceId),
          ...schedule,
          timeZone: values.timeZone,
          description: orNull(values.description),
          serviceProductIds: values.serviceProductIds,
          ...(values.availabilityGate?.conflictOverride
            ? { conflictOverride: values.availabilityGate.conflictOverride }
            : {}),
        }), t)
        if (embedded) flash(t('patient.visits.flash.updated'), 'success')
        await onSaved?.()
      }}
      onDelete={async () => {
        await deleteCrud('patient/visits', record.id)
        if (embedded) flash(t('patient.visits.flash.deleted'), 'success')
        await onSaved?.()
      }}
      />
      {ConfirmDialogElement}
    </>
  )
}

export function VisitCalendarDialog({
  state,
  onClose,
  onSaved,
  onChanged,
}: {
  state: VisitCalendarDialogState | null
  onClose: () => void
  onSaved: () => void | Promise<void>
  onChanged?: () => void | Promise<void>
}) {
  const t = useT()
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const isOpen = state !== null
  const finish = React.useCallback(async () => {
    await onSaved()
    onClose()
  }, [onClose, onSaved])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        ref={contentRef}
        size="xl"
        aria-describedby={undefined}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            const originDialog = event.target instanceof Element
              ? event.target.closest('[data-dialog-content]')
              : null
            if (originDialog !== contentRef.current) return
            event.preventDefault()
            const form = contentRef.current?.querySelector('form')
            if (form instanceof HTMLFormElement) form.requestSubmit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {state?.mode === 'edit'
              ? t('patient.visits.detail.title')
              : t('patient.visits.create.title')}
          </DialogTitle>
        </DialogHeader>
        {state?.mode === 'edit' ? (
          <VisitDetailForm
            key={`edit:${state.visitId}`}
            id={state.visitId}
            embedded
            onSaved={finish}
            onChanged={onChanged}
          />
        ) : state?.mode === 'create' ? (
          <VisitCreateForm
            key={`create:${seedInstant(state.seed?.startsAt) ?? 'blank'}`}
            embedded
            seed={state.seed}
            onSaved={finish}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
