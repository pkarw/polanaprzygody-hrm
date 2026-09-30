"use client"
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import type { SortingState } from '@tanstack/react-table'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import type { FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { deleteCrud, fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import extensionPoints from '../extension-points'
import type { PatientPagedResponse, PatientVisitItem } from '../types'
import {
  loadPatientOptions,
  loadResourceOptions,
  loadTeamMemberOptions,
} from './referencePickers'
import { usePatientVisitAccess } from './usePatientVisitAccess'

const LIST_HREF = '/backend/patient/visits'
const PAGE_SIZE = 25
type Translate = ReturnType<typeof useT>

function formatVisitTime(value: string, timeZone: string, locale: string | undefined): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(value))
  } catch {
    return value
  }
}

function localDayBoundary(value: string, nextDay = false): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + (nextDay ? 1 : 0))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function visitColumns(t: Translate, locale: string | undefined, hidePatient: boolean): ColumnDef<PatientVisitItem>[] {
  return [
    {
      accessorKey: 'startsAt',
      header: t('patient.visits.columns.startsAt'),
      meta: { priority: 1 },
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {formatVisitTime(row.original.startsAt, row.original.timeZone, locale)}
          <span className="ml-1 text-xs text-muted-foreground">{row.original.timeZone}</span>
        </span>
      ),
    },
    ...(hidePatient ? [] : [{
      accessorKey: 'patientName',
      header: t('patient.visits.columns.patient'),
      enableSorting: false,
      meta: { priority: 2 },
      cell: ({ getValue }: { getValue: () => unknown }) => {
        const value = getValue()
        return typeof value === 'string' && value.length > 0 ? value : <span className="text-muted-foreground">—</span>
      },
    } as ColumnDef<PatientVisitItem>]),
    {
      accessorKey: 'teamMemberName',
      header: t('patient.visits.columns.teamMember'),
      enableSorting: false,
      meta: { priority: 3 },
    },
    {
      accessorKey: 'resourceName',
      header: t('patient.visits.columns.resource'),
      enableSorting: false,
      meta: { priority: 5 },
      cell: ({ getValue }) => {
        const value = getValue()
        return typeof value === 'string' && value.length > 0
          ? value
          : <span className="text-muted-foreground">{t('patient.visits.resource.none')}</span>
      },
    },
    {
      id: 'services',
      header: t('patient.visits.columns.services'),
      enableSorting: false,
      meta: { priority: 6 },
      cell: ({ row }) => row.original.services.length > 0
        ? row.original.services.map((service) => service.title).join(', ')
        : <span className="text-muted-foreground">{t('patient.visits.services.none')}</span>,
    },
    {
      accessorKey: 'status',
      header: t('patient.visits.columns.status'),
      meta: { priority: 4 },
      cell: ({ getValue }) => {
        const status = String(getValue()) as PatientVisitItem['status']
        const variant = status === 'planned' ? 'info' : status === 'completed' ? 'success' : 'neutral'
        return <StatusBadge variant={variant} dot>{t(`patient.visits.status.${status}`)}</StatusBadge>
      },
    },
    {
      id: 'confirmation',
      header: t('patient.visits.columns.confirmation'),
      enableSorting: false,
      meta: { priority: 7 },
      cell: ({ row }) => (
        <StatusBadge variant={row.original.isConfirmed ? 'success' : 'warning'} appearance="light">
          {row.original.isConfirmed
            ? t('patient.visits.confirmation.confirmed')
            : t('patient.visits.confirmation.unconfirmed')}
        </StatusBadge>
      ),
    },
    {
      accessorKey: 'isSettled',
      header: t('patient.visits.columns.settlement'),
      meta: { priority: 8 },
      cell: ({ getValue }) => Boolean(getValue())
        ? <StatusBadge variant="success" appearance="light">{t('patient.visits.settlement.settled')}</StatusBadge>
        : <StatusBadge variant="neutral" appearance="light">{t('patient.visits.settlement.unsettled')}</StatusBadge>,
    },
  ]
}

export function VisitsTable({
  patientId,
  readOnly = false,
  embedded = false,
}: {
  patientId?: string
  readOnly?: boolean
  embedded?: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const queryClient = useQueryClient()
  const scopeVersion = useOrganizationScopeVersion()
  const access = usePatientVisitAccess()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'startsAt', desc: false }])
  const [page, setPage] = React.useState(1)

  const queryParams = React.useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      sortField: sorting[0]?.id || 'startsAt',
      sortDir: sorting[0]?.desc ? 'desc' : 'asc',
    })
    if (patientId) params.set('patientId', patientId)
    for (const [key, value] of Object.entries(filterValues)) {
      if (key === 'range' && value && typeof value === 'object') {
        const range = value as { from?: string; to?: string }
        const from = range.from ? localDayBoundary(range.from) : null
        const to = range.to ? localDayBoundary(range.to, true) : null
        if (from) params.set('from', from)
        if (to) params.set('to', to)
      } else if (typeof value === 'string' && value.length > 0) {
        params.set(key, value)
      }
    }
    return params.toString()
  }, [filterValues, page, patientId, sorting])

  const query = useQuery<PatientPagedResponse<PatientVisitItem>>({
    queryKey: ['patient.visits', queryParams, scopeVersion],
    queryFn: () => fetchCrudList<PatientVisitItem>('patient/visits', Object.fromEntries(new URLSearchParams(queryParams))),
  })
  const columns = React.useMemo(() => visitColumns(t, locale, Boolean(patientId)), [locale, patientId, t])
  const createHref = patientId ? `${LIST_HREF}/create?patientId=${encodeURIComponent(patientId)}` : `${LIST_HREF}/create`

  if (query.error) {
    return (
      <EmptyState
        title={t('patient.common.error')}
        description={query.error instanceof Error ? query.error.message : undefined}
        actions={<Button onClick={() => query.refetch()}>{t('patient.common.retry')}</Button>}
      />
    )
  }

  return (
    <>
      <DataTable<PatientVisitItem>
        title={embedded ? undefined : t('patient.visits.title')}
        titleHeadingLevel={embedded ? 2 : 1}
        actions={!readOnly && access.canManage ? (
          <Button asChild><Link href={createHref}>{t('patient.visits.actions.schedule')}</Link></Button>
        ) : undefined}
        columns={columns}
        data={query.data?.items ?? []}
        entityId="patient:patient_visit"
        perspective={{ tableId: extensionPoints.hosts.visitsTable.tableId }}
        filters={embedded ? [] : [
          { id: 'range', label: t('patient.visits.filters.range'), type: 'dateRange' },
          {
            id: 'status',
            label: t('patient.visits.filters.status'),
            type: 'select',
            options: ['planned', 'completed', 'cancelled', 'no_show'].map((value) => ({
              value,
              label: t(`patient.visits.status.${value}`),
            })),
          },
          { id: 'teamMemberId', label: t('patient.visits.filters.teamMember'), type: 'combobox', loadOptions: loadTeamMemberOptions, formatValue: () => t('patient.visits.filters.selected') },
          { id: 'resourceId', label: t('patient.visits.filters.resource'), type: 'combobox', loadOptions: loadResourceOptions, formatValue: () => t('patient.visits.filters.selected') },
          { id: 'patientId', label: t('patient.visits.filters.patient'), type: 'combobox', loadOptions: loadPatientOptions, formatValue: () => t('patient.visits.filters.selected') },
          {
            id: 'isSettled',
            label: t('patient.visits.filters.settlement'),
            type: 'select',
            options: [
              { value: 'false', label: t('patient.visits.settlement.unsettled') },
              { value: 'true', label: t('patient.visits.settlement.settled') },
            ],
          },
        ]}
        filterValues={filterValues}
        onFiltersApply={(values) => { setFilterValues(values); setPage(1) }}
        onFiltersClear={() => { setFilterValues({}); setPage(1) }}
        sortable
        sorting={sorting}
        onSortingChange={(next) => { setSorting(next); setPage(1) }}
        emptyState={(
          <EmptyState
            title={t('patient.visits.empty.title')}
            description={t('patient.visits.empty.body')}
            actions={!readOnly && access.canManage ? (
              <Button asChild><Link href={createHref}>{t('patient.visits.actions.schedule')}</Link></Button>
            ) : undefined}
          />
        )}
        rowActions={(row) => (
          <RowActions items={[
            { id: 'patient.visits.open', label: t('patient.visits.actions.open'), href: `${LIST_HREF}/${row.id}` },
            ...(!readOnly && access.canManage && row.status === 'planned' && !row.isSettled ? [{
              id: 'patient.visits.delete',
              label: t('patient.visits.actions.delete'),
              destructive: true,
              onSelect: async () => {
                const approved = await confirm({
                  title: t('patient.visits.confirm.delete.title'),
                  description: t('patient.visits.confirm.delete.body'),
                  variant: 'destructive',
                })
                if (!approved) return
                try {
                  await withScopedApiRequestHeaders(buildOptimisticLockHeader(row.updatedAt), () => deleteCrud('patient/visits', row.id))
                  flash(t('patient.visits.flash.deleted'), 'success')
                  queryClient.invalidateQueries({ queryKey: ['patient.visits'] })
                } catch (error) {
                  if (!surfaceRecordConflict(error, t)) {
                    flash(error instanceof Error ? error.message : t('patient.errors.unexpected'), 'error')
                  }
                }
              },
            }] : []),
          ]} />
        )}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          total: query.data?.total ?? 0,
          totalPages: query.data?.totalPages ?? 0,
          totalIsCapped: query.data?.totalIsCapped,
          onPageChange: setPage,
        }}
        isLoading={query.isLoading}
        onRowClick={(row) => router.push(`${LIST_HREF}/${row.id}`)}
      />
      {ConfirmDialogElement}
    </>
  )
}

export default VisitsTable
