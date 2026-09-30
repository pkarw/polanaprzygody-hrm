"use client"
import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { CrudForm, type CrudField, type CrudFieldOption, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { createCrud, deleteCrud, fetchCrudList, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { ErrorMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { DatePicker } from '@open-mercato/ui/primitives/date-picker'
import { FormField } from '@open-mercato/ui/primitives/form-field'
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
import { usePatientVisitAccess } from './usePatientVisitAccess'
import {
  defaultVisitTimeZone,
  instantOffsetInTimeZone,
  resolveVisitInstant,
  toVisitLocalDateTime,
  visitInstantChoices,
} from '../lib/visitDateTime'

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
  startOffset: string | null
  endOffset: string | null
  description: string | null
  serviceProductIds: string[]
  updatedAt?: string
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

const offsetOptions: CrudFieldOption[] = Array.from({ length: 113 }, (_, index) => index * 15 - 14 * 60)
  .map((minutes) => {
    const sign = minutes >= 0 ? '+' : '-'
    const absolute = Math.abs(minutes)
    const value = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
    return { value, label: `UTC${value}` }
  })

function resolveFormInstant(
  local: string,
  timeZone: string,
  offset: string | null,
  labels: { gap: string; fold: string; offset: string },
): string {
  const choices = visitInstantChoices(local, timeZone)
  if (choices.length === 0) throw new Error(labels.gap)
  if (choices.length > 1 && !offset) throw new Error(labels.fold)
  const selected = resolveVisitInstant(local, timeZone, offset)
  if (!selected) throw new Error(labels.offset)
  return selected.instant
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
      label: t('patient.visits.fields.teamMember'),
      type: 'custom',
      required: true,
      component: ({ value, setValue, disabled, values }) => (
        <VisitTeamMemberField
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => setValue(next)}
          patientId={typeof values?.patientId === 'string' ? values.patientId : undefined}
          disabled={disabled}
          historicalOption={referenceSeeds?.teamMember}
        />
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
      id: 'startOffset',
      label: t('patient.visits.fields.startOffset'),
      type: 'combobox',
      options: offsetOptions,
      allowCustomValues: false,
      description: t('patient.visits.fields.offsetHint'),
    },
    {
      id: 'endOffset',
      label: t('patient.visits.fields.endOffset'),
      type: 'combobox',
      options: offsetOptions,
      allowCustomValues: false,
      description: t('patient.visits.fields.offsetHint'),
    },
    {
      id: 'serviceProductIds',
      label: t('patient.visits.services.label'),
      type: 'custom',
      rendersOwnError: true,
      component: ({ value, setValue, disabled }) => (
        <VisitServicesField
          value={Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []}
          onChange={setValue}
          disabled={disabled}
          seedServices={seedServices}
        />
      ),
    },
    accessibleDescriptionField({
      label: t('patient.visits.fields.description'),
      description: t('patient.visits.fields.descriptionHint'),
    }),
  ], [patientReadOnly, referenceSeeds?.resource, referenceSeeds?.teamMember, seedServices, t])
}

function useVisitGroups(): CrudFormGroup[] {
  const t = useT()
  return React.useMemo(() => [
    { id: 'patient', title: t('patient.visits.groups.patient'), column: 1, fields: ['patientId', 'teamMemberId', 'resourceId'] },
    { id: 'schedule', title: t('patient.visits.groups.schedule'), column: 2, fields: ['startsAtLocal', 'endsAtLocal', 'timeZone', 'startOffset', 'endOffset'] },
    { id: 'services', title: t('patient.visits.groups.services'), column: 1, fields: ['serviceProductIds'] },
    { id: 'description', title: t('patient.visits.groups.description'), column: 2, fields: ['description'] },
  ], [t])
}

function buildSchedule(values: VisitFormValues, t: ReturnType<typeof useT>) {
  const labels = {
    gap: t('patient.visits.validation.dstGap'),
    fold: t('patient.visits.validation.dstFold'),
    offset: t('patient.visits.validation.offset'),
  }
  const startsAt = resolveFormInstant(values.startsAtLocal, values.timeZone, orNull(values.startOffset), labels)
  const endsAt = values.endsAtLocal
    ? resolveFormInstant(values.endsAtLocal, values.timeZone, orNull(values.endOffset), labels)
    : null
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new Error(t('patient.visits.validation.endAfterStart'))
  }
  return { startsAt, endsAt }
}

export function VisitCreateForm() {
  const t = useT()
  const searchParams = useSearchParams()
  const suggestedPatientId = searchParams.get('patientId') ?? ''
  const fields = useVisitFields()
  const groups = useVisitGroups()
  const clientRequestId = React.useMemo(() => crypto.randomUUID(), [])
  const initialValues = React.useMemo<Partial<VisitFormValues>>(() => ({
    patientId: suggestedPatientId,
    teamMemberId: '',
    resourceId: null,
    startsAtLocal: '',
    endsAtLocal: null,
    timeZone: defaultVisitTimeZone(),
    startOffset: null,
    endOffset: null,
    description: null,
    serviceProductIds: [],
  }), [suggestedPatientId])

  return (
    <CrudForm<VisitFormValues>
      title={t('patient.visits.create.title')}
      titleHeadingLevel={1}
      backHref={LIST_HREF}
      entityId={ENTITY_ID}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={t('patient.visits.actions.save')}
      cancelHref={LIST_HREF}
      successRedirect={`${LIST_HREF}?flash=${encodeURIComponent(t('patient.visits.flash.created'))}&type=success`}
      onSubmit={async (values) => {
        const schedule = buildSchedule(values, t)
        await createCrud('patient/visits', {
          patientId: values.patientId,
          teamMemberId: values.teamMemberId,
          resourceId: orNull(values.resourceId),
          ...schedule,
          timeZone: values.timeZone,
          description: orNull(values.description),
          serviceProductIds: values.serviceProductIds,
          clientRequestId,
        })
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
    startOffset: instantOffsetInTimeZone(record.startsAt, record.timeZone),
    endOffset: record.endsAt ? instantOffsetInTimeZone(record.endsAt, record.timeZone) : null,
    description: record.description ?? null,
    serviceProductIds: record.services.map((service) => service.productId),
    updatedAt: record.updatedAt,
  }
}

export function VisitDetailForm({ id }: { id: string }) {
  const t = useT()
  const access = usePatientVisitAccess()
  const query = useQuery<PatientPagedResponse<PatientVisitItem>>({
    queryKey: ['patient.visits', 'detail', id],
    queryFn: () => fetchCrudList<PatientVisitItem>('patient/visits', { id, pageSize: 1 }),
  })
  const record = query.data?.items?.[0]
  const seedServices = React.useMemo<VisitServiceSeed[]>(
    () => record?.services.map((service) => ({ productId: service.productId, title: service.title, sku: service.sku })) ?? [],
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
  const fields = useVisitFields(seedServices, true, referenceSeeds)
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
    <CrudForm<VisitFormValues>
      title={t('patient.visits.detail.title')}
      titleHeadingLevel={1}
      backHref={LIST_HREF}
      entityId={ENTITY_ID}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      disableInitialFocus
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
      cancelHref={LIST_HREF}
      successRedirect={`${LIST_HREF}?flash=${encodeURIComponent(t('patient.visits.flash.updated'))}&type=success`}
      deleteRedirect={`${LIST_HREF}?flash=${encodeURIComponent(t('patient.visits.flash.deleted'))}&type=success`}
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
          </div>
          <VisitLifecycleActions
            visit={record}
            access={access}
            onSaved={() => query.refetch()}
          />
        </div>
      )}
      onSubmit={async (values) => {
        const schedule = buildSchedule(values, t)
        await updateCrud('patient/visits', {
          id: record.id,
          expectedUpdatedAt: values.updatedAt ?? record.updatedAt,
          teamMemberId: values.teamMemberId,
          resourceId: orNull(values.resourceId),
          ...schedule,
          timeZone: values.timeZone,
          description: orNull(values.description),
          serviceProductIds: values.serviceProductIds,
        })
      }}
      onDelete={async () => {
        await deleteCrud('patient/visits', record.id)
      }}
    />
  )
}
