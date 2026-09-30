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
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { deleteCrud, fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useCustomFieldDefs, type CustomFieldDefDto } from '@open-mercato/ui/backend/utils/customFieldDefs'
import { applyCustomFieldVisibility } from '@open-mercato/ui/backend/utils/customFieldColumns'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { formatDate } from '@open-mercato/ui/utils/format'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import extensionPoints from '../extension-points'
import type { PatientListItem, PatientPagedResponse } from '../types'
import { usePatientVisitAccess } from './usePatientVisitAccess'

const LIST_HREF = '/backend/patient/patients'
const PAGE_SIZE = 50
const EMPTY_CUSTOM_FIELD_DEFS: CustomFieldDefDto[] = []

type Translate = ReturnType<typeof useT>

/**
 * The patient register list.
 *
 * One search box covers the number, the name and the contact channels, but the route has
 * to resolve it two different ways: the number is plaintext and takes a real substring
 * match, while the names and contact channels are encrypted at rest, so `%kow%` would be
 * compared against ciphertext and match nothing — those are resolved through the hashed
 * token index instead. See `resolvePatientSearchIds` in the route.
 *
 * Sorting offers only plaintext columns. Offering "sort by surname" would hand the engine
 * an encrypted column, which it can only sort by decrypting a capped number of rows in
 * memory — correct for a small page and silently partial beyond it.
 *
 * There is no export control: `allowCsv` is false on the route, and a clinical export is a
 * spec non-goal.
 *
 * The "Kolejna wizyta" column appears only after the feature probe explicitly grants
 * `patient.visits.view`. The route repeats that authorization check for sorting and omits
 * the projection otherwise, so hiding the column is not the security boundary.
 */
export default function PatientsTable() {
  const t = useT()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const scopeVersion = useOrganizationScopeVersion()
  const locale = useLocale()
  const visitAccess = usePatientVisitAccess()

  const [search, setSearch] = React.useState('')
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'createdAt', desc: true }])
  const [page, setPage] = React.useState(1)

  const queryParams = React.useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      sortField: sorting[0]?.id || 'createdAt',
      sortDir: sorting[0]?.desc ? 'desc' : 'asc',
    })
    // One box, one parameter. The route resolves it against the plaintext patient number
    // AND the hashed token index that makes the encrypted name and contact columns
    // findable — neither half works for the other's columns, so the split lives there.
    if (search.trim()) params.set('search', search.trim())
    for (const [key, value] of Object.entries(filterValues)) {
      if (key === 'status') {
        if (typeof value === 'string' && value.length > 0) params.set('status', value)
        continue
      }
      if (key.startsWith('cf_')) {
        if (Array.isArray(value)) params.set(key, value.map((entry) => String(entry)).join(','))
        else if (value != null && value !== '') params.set(key, String(value))
      }
    }
    return params.toString()
  }, [filterValues, page, search, sorting])

  const { data: rawCfDefs } = useCustomFieldDefs('patient:patient', { keyExtras: [scopeVersion] })
  const cfDefs = rawCfDefs ?? EMPTY_CUSTOM_FIELD_DEFS

  const computedColumns = React.useMemo(() => {
    const base = buildPatientColumns(t, locale, visitAccess.status === 'ready' && visitAccess.canView)
    if (!cfDefs.length) return base
    return withCustomFieldDateCells(applyCustomFieldVisibility(base, cfDefs), cfDefs, locale)
  }, [cfDefs, locale, t, visitAccess.canView, visitAccess.status])

  React.useEffect(() => {
    if (visitAccess.status === 'ready' && !visitAccess.canView && sorting[0]?.id === 'nextVisit') {
      setSorting([{ id: 'createdAt', desc: true }])
      setPage(1)
    }
  }, [sorting, visitAccess.canView, visitAccess.status])

  const {
    data: patientsData,
    isLoading,
    error,
    refetch,
  } = useQuery<PatientPagedResponse<PatientListItem>>({
    queryKey: ['patient.patients', queryParams, scopeVersion],
    queryFn: async () =>
      fetchCrudList<PatientListItem>(
        'patient/patients',
        Object.fromEntries(new URLSearchParams(queryParams)),
      ),
  })

  const handleSortingChange = React.useCallback((next: SortingState) => {
    setSorting(next)
    setPage(1)
  }, [])

  // A failed load offers a retry rather than replacing the page, so the operator does not
  // lose the search and filters they typed.
  if (error) {
    return (
      <EmptyState
        title={t('patient.common.error')}
        description={error instanceof Error ? error.message : undefined}
        actions={<Button onClick={() => refetch()}>{t('patient.common.retry')}</Button>}
      />
    )
  }

  return (
    <>
      <DataTable<PatientListItem>
        title={t('patient.patients.title')}
        titleHeadingLevel={1}
        actions={(
          <Button asChild>
            <Link href={`${LIST_HREF}/create`}>{t('patient.patients.actions.add')}</Link>
          </Button>
        )}
        columns={computedColumns}
        data={patientsData?.items ?? []}
        entityId="patient:patient"
        perspective={{ tableId: extensionPoints.hosts.patientsTable.tableId }}
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value)
          setPage(1)
        }}
        searchPlaceholder={t('patient.patients.filters.search')}
        // Left is the framework default and what every other list in this installation
        // renders: search on the left, "Filters" pushed to the right.
        searchAlign="left"
        filters={[
          {
            id: 'status',
            label: t('patient.patients.filters.status'),
            type: 'select',
            options: [
              { value: 'active', label: t('patient.patients.status.active') },
              { value: 'archived', label: t('patient.patients.status.archived') },
            ],
          },
        ]}
        filterValues={filterValues}
        onFiltersApply={(values: FilterValues) => {
          setFilterValues(values)
          setPage(1)
        }}
        onFiltersClear={() => {
          setFilterValues({})
          setSearch('')
          setPage(1)
        }}
        sortable
        sorting={sorting}
        onSortingChange={handleSortingChange}
        emptyState={(
          <EmptyState
            title={t('patient.patients.empty.title')}
            description={t('patient.patients.empty.body')}
            actions={(
              <Button asChild>
                <Link href={`${LIST_HREF}/create`}>{t('patient.patients.actions.add')}</Link>
              </Button>
            )}
          />
        )}
        rowActions={(row) => (
          <RowActions
            items={[
              {
                id: 'patient.patients.open',
                label: t('patient.patients.actions.open'),
                href: `${LIST_HREF}/${row.id}`,
              },
              {
                // Archiving reaches the record from the list because the detail page's
                // header carries the record form's actions instead. Restoring is offered
                // on the archived record itself as well, from its own notice.
                id: 'patient.patients.archive',
                label:
                  row.status === 'archived'
                    ? t('patient.patients.actions.restore')
                    : t('patient.patients.actions.archive'),
                onSelect: async () => {
                  const archived = row.status !== 'archived'
                  const confirmed = await confirm({
                    title: archived
                      ? t('patient.patients.confirm.archive.title')
                      : t('patient.patients.confirm.restore.title'),
                    description: archived
                      ? t('patient.patients.confirm.archive.body')
                      : t('patient.patients.confirm.restore.body'),
                  })
                  if (!confirmed) return
                  try {
                    await withScopedApiRequestHeaders(
                      buildOptimisticLockHeader(row.updatedAt),
                      () =>
                        apiCallOrThrow(
                          `/api/patient/patients/${encodeURIComponent(row.id)}/archive`,
                          {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ archived, expectedUpdatedAt: row.updatedAt }),
                          },
                        ),
                    )
                    flash(
                      archived
                        ? t('patient.patients.flash.archived')
                        : t('patient.patients.flash.restored'),
                      'success',
                    )
                    queryClient.invalidateQueries({ queryKey: ['patient.patients'] })
                  } catch (err) {
                    if (surfaceRecordConflict(err, t)) {
                      queryClient.invalidateQueries({ queryKey: ['patient.patients'] })
                      return
                    }
                    flash(
                      err instanceof Error && err.message
                        ? err.message
                        : t('patient.patients.error.load'),
                      'error',
                    )
                  }
                },
              },
              {
                id: 'patient.patients.delete',
                label: t('patient.patients.actions.delete'),
                destructive: true,
                onSelect: async () => {
                  const confirmed = await confirm({
                    title: t('patient.patients.confirm.delete.title'),
                    description: t('patient.patients.confirm.delete.body'),
                    variant: 'destructive',
                  })
                  if (!confirmed) return
                  try {
                    // The row's own version travels with the delete, so a list rendered
                    // before someone else edited the record fails with a 409 instead of
                    // deleting a record the operator never saw in its current state.
                    await withScopedApiRequestHeaders(
                      buildOptimisticLockHeader(row.updatedAt),
                      () => deleteCrud('patient/patients', row.id),
                    )
                    flash(t('patient.patients.flash.deleted'), 'success')
                    queryClient.invalidateQueries({ queryKey: ['patient.patients'] })
                  } catch (err) {
                    if (surfaceRecordConflict(err, t)) {
                      queryClient.invalidateQueries({ queryKey: ['patient.patients'] })
                      return
                    }
                    // A record with documentation is refused with a 409 carrying
                    // `patient_not_empty`. The message names archiving as the way forward
                    // rather than reporting a bare failure.
                    const message =
                      err instanceof Error && err.message
                        ? err.message
                        : t('patient.patients.error.delete')
                    flash(message, 'error')
                  }
                },
              },
            ]}
          />
        )}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          total: patientsData?.total ?? 0,
          totalPages: patientsData?.totalPages ?? 0,
          totalIsCapped: patientsData?.totalIsCapped === true,
          onPageChange: setPage,
        }}
        isLoading={isLoading}
        onRowClick={(row) => router.push(`${LIST_HREF}/${row.id}`)}
      />
      {ConfirmDialogElement}
    </>
  )
}

/**
 * Renders date and datetime custom fields as dates rather than raw ISO strings.
 *
 * `applyCustomFieldVisibility` appends a column per visible definition with an
 * `accessorKey` and no `cell`, so the stored value is printed verbatim — which for a date
 * field means `2026-09-08T22:00:00.000Z` in a register operators read at a glance. The
 * formatting is applied only to the kinds where the raw form is unreadable; every other
 * kind keeps the framework's default rendering.
 */
function withCustomFieldDateCells(
  columns: ColumnDef<PatientListItem>[],
  defs: CustomFieldDefDto[],
  locale: string | undefined,
): ColumnDef<PatientListItem>[] {
  const dateKeys = new Set(
    defs.filter((def) => def.kind === 'date' || def.kind === 'datetime').map((def) => def.key),
  )
  if (dateKeys.size === 0) return columns
  return columns.map((column) => {
    const accessorKey = String((column as { accessorKey?: unknown }).accessorKey ?? '')
    if (!accessorKey.startsWith('cf_')) return column
    if (!dateKeys.has(accessorKey.slice(3))) return column
    if ((column as { cell?: unknown }).cell) return column
    return {
      ...column,
      cell: ({ getValue }: { getValue: () => unknown }) => {
        const value = getValue()
        const formatted = typeof value === 'string' ? formatDate(value, locale) : null
        return formatted ?? <span className="text-muted-foreground">—</span>
      },
    } as ColumnDef<PatientListItem>
  })
}

function formatNextVisitDate(value: string, timeZone: string, locale: string | undefined): string {
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

export function buildPatientColumns(
  t: Translate,
  locale: string | undefined,
  showNextVisit = false,
): ColumnDef<PatientListItem>[] {
  const columns: ColumnDef<PatientListItem>[] = [
    {
      accessorKey: 'patientNumber',
      header: t('patient.patients.columns.number'),
      meta: { priority: 2 },
    },
    ...(showNextVisit ? [{
      id: 'nextVisit',
      header: t('patient.patients.columns.nextVisit'),
      meta: { priority: 3 },
      cell: ({ row }: { row: { original: PatientListItem } }) => {
        const nextVisit = row.original.nextVisit
        if (!nextVisit) {
          return <span className="text-muted-foreground">{t('patient.patients.nextVisit.none')}</span>
        }
        return (
          <div className="min-w-40 space-y-1">
            <div className="whitespace-nowrap">
              {formatNextVisitDate(nextVisit.startsAt, nextVisit.timeZone, locale)}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {nextVisit.resourceNameSnapshot ? <span>{nextVisit.resourceNameSnapshot}</span> : null}
              <StatusBadge
                variant={nextVisit.confirmedAt ? 'success' : 'warning'}
                appearance="light"
              >
                {nextVisit.confirmedAt
                  ? t('patient.patients.nextVisit.confirmed')
                  : t('patient.patients.nextVisit.unconfirmed')}
              </StatusBadge>
            </div>
          </div>
        )
      },
    } as ColumnDef<PatientListItem>] : []),
    {
      accessorKey: 'displayName',
      header: t('patient.patients.columns.name'),
      // Encrypted column: the engine can only order it by decrypting a capped number of
      // rows in memory, so offering the sort would offer a silently partial ordering.
      enableSorting: false,
      meta: { priority: 1 },
      cell: ({ getValue }) => {
        const value = getValue()
        return typeof value === 'string' && value.length > 0
          ? value
          : <span className="text-muted-foreground">—</span>
      },
    },
    {
      id: 'contact',
      header: t('patient.patients.columns.contact'),
      enableSorting: false,
      meta: { priority: 3 },
      // The patient's OWN channel, and only one line of it: the register list is read by
      // reception, and two channels per row turns the grid into a contact export.
      cell: ({ row }) => {
        const { email, phone } = row.original
        const value = email ?? phone
        return value ? value : <span className="text-muted-foreground">—</span>
      },
    },
    {
      id: 'owner',
      header: t('patient.patients.columns.owner'),
      enableSorting: false,
      meta: { priority: 4 },
      cell: ({ row }) => {
        const owner = row.original.owner
        if (!owner) {
          // Either nobody is assigned or the staff member no longer resolves in this
          // scope. Both read as "no carer shown"; neither ever renders a raw uuid.
          return <span className="text-muted-foreground">—</span>
        }
        if (!owner.isAvailable) {
          return (
            <span className="text-muted-foreground">
              {owner.name} ({t('patient.common.unavailableReference')})
            </span>
          )
        }
        return owner.name
      },
    },
    {
      // Present so the default ordering has a column to belong to. Without it the table
      // is handed a sorting state for an id it does not render — TanStack logs
      // "Column with id 'created_at' does not exist" and the operator sees a register
      // sorted by something with no header to click.
      accessorKey: 'createdAt',
      header: t('patient.patients.columns.createdAt'),
      meta: { priority: 6 },
      cell: ({ getValue }) => {
        const value = getValue()
        const formatted = typeof value === 'string' ? formatDate(value, locale) : null
        return formatted ?? <span className="text-muted-foreground">—</span>
      },
    },
    {
      accessorKey: 'status',
      header: t('patient.patients.columns.status'),
      meta: { priority: 5 },
      cell: ({ getValue }) => {
        const status = getValue() === 'archived' ? 'archived' : 'active'
        return (
          <StatusBadge variant={status === 'active' ? 'success' : 'neutral'} dot>
            {t(`patient.patients.status.${status}`)}
          </StatusBadge>
        )
      },
    },
  ]
  return columns
}
