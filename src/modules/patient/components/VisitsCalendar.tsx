"use client"

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ScheduleView,
  type ScheduleItem,
  type ScheduleRange,
  type ScheduleSlot,
  type ScheduleViewMode,
} from '@open-mercato/ui/backend/schedule'
import { FilterBar, type FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { PageHeader } from '@open-mercato/ui/backend/Page'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { addDays } from 'date-fns/addDays'
import { addMinutes } from 'date-fns/addMinutes'
import { endOfDay } from 'date-fns/endOfDay'
import { endOfMonth } from 'date-fns/endOfMonth'
import { endOfWeek } from 'date-fns/endOfWeek'
import { format } from 'date-fns/format'
import { startOfDay } from 'date-fns/startOfDay'
import { startOfMonth } from 'date-fns/startOfMonth'
import { startOfWeek } from 'date-fns/startOfWeek'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import type { PatientVisitCalendarItem, PatientVisitCalendarResponse } from '../types'
import { defaultVisitTimeZone } from '../lib/visitDateTime'
import {
  VisitCalendarDialog,
  type VisitCalendarDialogState,
} from './VisitForm'
import {
  loadPatientOptions,
  loadResourceOptions,
  loadTeamMemberOptions,
} from './referencePickers'
import { usePatientVisitAccess } from './usePatientVisitAccess'

const LIST_HREF = '/backend/patient/visits'
const VIEWS = new Set<ScheduleViewMode>(['day', 'week', 'month', 'agenda'])
const MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1_000

type CalendarFilters = {
  teamMemberId?: string
  resourceId?: string
  patientId?: string
  status?: string
}

type CalendarState = {
  view: ScheduleViewMode
  range: ScheduleRange
  timeZone: string
  filters: CalendarFilters
}

function validTimeZone(value: string | null): string {
  if (!value) return defaultVisitTimeZone()
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format(new Date())
    return value
  } catch {
    return defaultVisitTimeZone()
  }
}

function rangeForView(anchor: Date, view: ScheduleViewMode): ScheduleRange {
  if (view === 'day') {
    const start = startOfDay(anchor)
    return { start, end: endOfDay(start) }
  }
  if (view === 'month') {
    return { start: startOfMonth(anchor), end: endOfMonth(anchor) }
  }
  if (view === 'agenda') {
    const start = startOfDay(anchor)
    return { start, end: endOfDay(addDays(start, 6)) }
  }
  return {
    start: startOfWeek(anchor, { weekStartsOn: 1 }),
    end: endOfWeek(anchor, { weekStartsOn: 1 }),
  }
}

function apiRange(range: ScheduleRange, timeZone: string): { from: string; to: string } {
  const from = fromZonedTime(startOfDay(range.start), timeZone)
  const to = fromZonedTime(startOfDay(addDays(range.end, 1)), timeZone)
  return { from: from.toISOString(), to: to.toISOString() }
}

function initialState(params: URLSearchParams): CalendarState {
  const timeZone = validTimeZone(params.get('timeZone'))
  const viewParam = params.get('view') as ScheduleViewMode | null
  const view = viewParam && VIEWS.has(viewParam) ? viewParam : 'week'
  const fromValue = params.get('from')
  const toValue = params.get('to')
  const parsedFrom = fromValue ? new Date(fromValue) : null
  const parsedTo = toValue ? new Date(toValue) : null
  const hasRange = parsedFrom && parsedTo
    && Number.isFinite(parsedFrom.getTime())
    && Number.isFinite(parsedTo.getTime())
    && parsedFrom < parsedTo
  const range = hasRange
    ? {
        start: startOfDay(toZonedTime(parsedFrom, timeZone)),
        end: endOfDay(toZonedTime(new Date(parsedTo.getTime() - 1), timeZone)),
      }
    : rangeForView(toZonedTime(new Date(), timeZone), view)
  const readFilter = (key: keyof CalendarFilters) => params.get(key) || undefined
  return {
    view,
    range,
    timeZone,
    filters: {
      teamMemberId: readFilter('teamMemberId'),
      resourceId: readFilter('resourceId'),
      patientId: readFilter('patientId'),
      status: readFilter('status'),
    },
  }
}

function displayInstant(value: string, timeZone: string): Date {
  return toZonedTime(new Date(value), timeZone)
}

function scheduleStatus(visit: PatientVisitCalendarItem): ScheduleItem['status'] {
  if (visit.status === 'cancelled') return 'cancelled'
  if (visit.status === 'no_show') return 'negotiation'
  if (visit.status === 'completed' || visit.confirmedAt) return 'confirmed'
  return 'draft'
}

function filterString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeAvailabilityBands(root: HTMLElement): void {
  for (const element of root.querySelectorAll<HTMLElement>(
    '.schedule-event-availability, .schedule-event-exception',
  )) {
    if (element.tabIndex !== -1) element.tabIndex = -1
    if (element.getAttribute('aria-hidden') !== 'true') element.setAttribute('aria-hidden', 'true')
    if (!element.classList.contains('pointer-events-none')) element.classList.add('pointer-events-none')
    if (!element.classList.contains('cursor-default')) element.classList.add('cursor-default')
  }
}

export function VisitsCalendar() {
  const t = useT()
  const locale = useLocale()
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const searchString = searchParams.toString()
  const scopeVersion = useOrganizationScopeVersion()
  const queryClient = useQueryClient()
  const access = usePatientVisitAccess()
  const scheduleObserverRef = React.useRef<MutationObserver | null>(null)
  const setScheduleRootRef = React.useCallback((root: HTMLDivElement | null) => {
    scheduleObserverRef.current?.disconnect()
    scheduleObserverRef.current = null
    if (!root) return
    const normalize = () => normalizeAvailabilityBands(root)
    normalize()
    const observer = new MutationObserver(normalize)
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'tabindex', 'aria-hidden'],
    })
    scheduleObserverRef.current = observer
  }, [])
  const [state, setState] = React.useState<CalendarState>(() => initialState(new URLSearchParams(searchString)))
  const [dialog, setDialog] = React.useState<VisitCalendarDialogState | null>(null)
  const range = React.useMemo(() => apiRange(state.range, state.timeZone), [state.range, state.timeZone])
  const rangeTooWide = React.useMemo(
    () => new Date(range.to).getTime() - new Date(range.from).getTime() > MAX_RANGE_MS,
    [range],
  )

  React.useEffect(() => {
    const handlePopState = () => setState(initialState(new URLSearchParams(window.location.search)))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  React.useEffect(() => {
    if (new URLSearchParams(searchString).has('view')) return
    if (!window.matchMedia('(max-width: 768px)').matches) return
    setState((current) => ({
      ...current,
      view: 'day',
      range: rangeForView(current.range.start, 'day'),
    }))
  }, [searchString])

  React.useEffect(() => {
    const next = new URLSearchParams(searchString)
    const serializedRange = apiRange(state.range, state.timeZone)
    next.set('from', serializedRange.from)
    next.set('to', serializedRange.to)
    next.set('view', state.view)
    next.set('timeZone', state.timeZone)
    for (const key of ['teamMemberId', 'resourceId', 'patientId', 'status'] as const) {
      const value = state.filters[key]
      if (value) next.set(key, value)
      else next.delete(key)
    }
    const nextString = next.toString()
    if (nextString !== searchString) router.replace(`${pathname}?${nextString}`, { scroll: false })
  }, [pathname, router, searchString, state])

  const queryString = React.useMemo(() => {
    const params = new URLSearchParams(range)
    for (const [key, value] of Object.entries(state.filters)) {
      if (value) params.set(key, value)
    }
    return params.toString()
  }, [range, state.filters])

  const query = useQuery<PatientVisitCalendarResponse>({
    queryKey: ['patient.visits', 'calendar', queryString, scopeVersion],
    queryFn: () => readApiResultOrThrow<PatientVisitCalendarResponse>(`/api/patient/visits/calendar?${queryString}`),
    enabled: access.status === 'ready' && access.canView && !rangeTooWide,
  })

  const scheduleItems = React.useMemo<ScheduleItem[]>(() => {
    if (!query.data) return []
    const laneItems = query.data.lanes.flatMap((lane) => lane.windows.map((window): ScheduleItem => {
      const laneLabel = window.kind === 'availability'
        ? t('patient.visits.calendar.availableLane', undefined, { name: lane.subjectName })
        : t('patient.visits.calendar.unavailableLane', undefined, { name: lane.subjectName })
      return {
        id: `lane:${lane.subjectType}:${lane.subjectId}:${window.id}`,
        kind: window.kind,
        title: window.reasonLabel ? `${laneLabel} · ${window.reasonLabel}` : laneLabel,
        startsAt: displayInstant(window.from, state.timeZone),
        endsAt: displayInstant(window.to, state.timeZone),
        status: window.kind === 'availability' ? 'confirmed' : 'cancelled',
        subjectType: lane.subjectType,
        subjectId: lane.subjectId,
        metadata: { itemType: 'availability-band' },
      }
    }))
    const visits = query.data.items.map((visit): ScheduleItem => {
      const startsAt = displayInstant(visit.startsAt, state.timeZone)
      const endsAt = visit.endsAt
        ? displayInstant(visit.endsAt, state.timeZone)
        : addMinutes(startsAt, 60)
      const patient = visit.patientName ?? t('patient.visits.calendar.patientUnavailable')
      const resource = visit.resourceName ? ` · ${visit.resourceName}` : ''
      const title = `${format(startsAt, 'HH:mm')} · ${patient} · ${visit.teamMemberName}${resource} · ${t(`patient.visits.status.${visit.status}`)}${visit.endsAt ? '' : ` · ${t('patient.visits.calendar.unknownDuration')}`}`
      return {
        id: `visit:${visit.id}`,
        kind: 'event',
        title: visit.conflictOverrideAt
          ? `${title} · ${t('patient.visits.calendar.overrideMarker')}`
          : title,
        startsAt,
        endsAt,
        status: scheduleStatus(visit),
        subjectType: 'member',
        subjectId: visit.teamMemberId,
        linkLabel: t('patient.visits.actions.open'),
        metadata: { visitId: visit.id, itemType: 'visit' },
      }
    })
    return [...laneItems, ...visits]
  }, [query.data, state.timeZone, t])

  const filterValues = React.useMemo<FilterValues>(() => ({ ...state.filters }), [state.filters])
  const invalidateVisits = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['patient.visits'] })
  }, [queryClient])
  const openCreate = React.useCallback((slot?: ScheduleSlot) => {
    const selected = slot ?? { start: state.range.start, end: addMinutes(state.range.start, 30) }
    const normalized = state.view === 'month' || selected.end.getTime() - selected.start.getTime() >= 12 * 60 * 60 * 1_000
      ? {
          start: addMinutes(startOfDay(selected.start), 9 * 60),
          end: addMinutes(startOfDay(selected.start), 10 * 60),
        }
      : selected
    setDialog({
      mode: 'create',
      seed: {
        startsAt: fromZonedTime(normalized.start, state.timeZone),
        endsAt: fromZonedTime(normalized.end, state.timeZone),
        timeZone: state.timeZone,
        teamMemberId: state.filters.teamMemberId,
        resourceId: state.filters.resourceId ?? null,
        patientId: state.filters.patientId,
      },
    })
  }, [state])
  const rangeLabel = React.useMemo(() => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: state.timeZone,
  }).formatRange(new Date(range.from), new Date(new Date(range.to).getTime() - 1)), [locale, range, state.timeZone])
  const laneWindowFormatter = React.useMemo(() => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: state.timeZone,
  }), [locale, state.timeZone])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('patient.visits.calendar.title')}
        description={t('patient.visits.calendar.description')}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-md border p-0.5" role="group" aria-label={t('patient.visits.calendar.viewSwitcher')}>
              <Button asChild size="sm" variant="ghost">
                <Link href={LIST_HREF}>{t('patient.visits.calendar.listView')}</Link>
              </Button>
              <Button size="sm" variant="secondary" aria-current="page" disabled>
                {t('patient.visits.calendar.calendarView')}
              </Button>
            </div>
            {access.status === 'ready' && access.canManage ? (
              <Button type="button" onClick={() => openCreate()}>
                {t('patient.visits.actions.schedule')}
              </Button>
            ) : null}
          </div>
        )}
      />

      <FilterBar
        layout="inline"
        filters={[
          { id: 'teamMemberId', label: t('patient.visits.filters.teamMember'), type: 'combobox', loadOptions: loadTeamMemberOptions, formatValue: () => t('patient.visits.filters.selected') },
          { id: 'resourceId', label: t('patient.visits.filters.resource'), type: 'combobox', loadOptions: loadResourceOptions, formatValue: () => t('patient.visits.filters.selected') },
          { id: 'patientId', label: t('patient.visits.filters.patient'), type: 'combobox', loadOptions: loadPatientOptions, formatValue: () => t('patient.visits.filters.selected') },
          {
            id: 'status',
            label: t('patient.visits.filters.status'),
            type: 'select',
            options: ['planned', 'completed', 'cancelled', 'no_show'].map((value) => ({
              value,
              label: t(`patient.visits.status.${value}`),
            })),
          },
        ]}
        values={filterValues}
        onApply={(values) => setState((current) => ({
          ...current,
          filters: {
            teamMemberId: filterString(values.teamMemberId),
            resourceId: filterString(values.resourceId),
            patientId: filterString(values.patientId),
            status: filterString(values.status),
          },
        }))}
        onClear={() => setState((current) => ({ ...current, filters: {} }))}
      />

      <p className="sr-only" role="status" aria-live="polite">
        {t('patient.visits.calendar.rangeAnnouncement', undefined, { range: rangeLabel })}
      </p>

      {access.status === 'unknown' ? (
        <LoadingMessage label={t('patient.visits.calendar.loading')} />
      ) : access.status !== 'ready' || !access.canView ? (
        <Alert status="warning">
          <AlertTitle>{t('patient.visits.calendar.permissionUnavailableTitle')}</AlertTitle>
          <AlertDescription>{t('patient.visits.calendar.permissionUnavailable')}</AlertDescription>
        </Alert>
      ) : rangeTooWide ? (
        <Alert status="warning">
          <AlertTitle>{t('patient.visits.calendar.rangeTooWideTitle')}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{t('patient.visits.calendar.rangeTooWideBody')}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setState((current) => ({
                ...current,
                view: 'month',
                range: rangeForView(current.range.start, 'month'),
              }))}
            >
              {t('patient.visits.calendar.showMonth')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : query.isLoading ? (
        <LoadingMessage label={t('patient.visits.calendar.loading')} />
      ) : query.error ? (
        <ErrorMessage
          label={query.error instanceof Error ? query.error.message : t('patient.common.error')}
          action={<Button variant="outline" onClick={() => void query.refetch()}>{t('patient.common.retry')}</Button>}
        />
      ) : (
        <>
          {query.data?.degraded.length ? (
            <Alert status="warning">
              <AlertTitle>{t('patient.visits.calendar.degradedTitle')}</AlertTitle>
              <AlertDescription>
                {t('patient.visits.calendar.degradedBody', undefined, { count: query.data.degraded.length })}
              </AlertDescription>
            </Alert>
          ) : null}
          {query.data?.lanes.some((lane) => lane.hasSchedule === false) ? (
            <Alert status="information">
              <AlertTitle>{t('patient.visits.calendar.noScheduleTitle')}</AlertTitle>
              <AlertDescription>{t('patient.visits.calendar.noScheduleBody')}</AlertDescription>
            </Alert>
          ) : null}
          {query.data?.lanes.some((lane) => lane.subjectType === 'resource' && lane.isActive === false) ? (
            <Alert status="warning">
              <AlertTitle>{t('patient.visits.calendar.inactiveResourceTitle')}</AlertTitle>
              <AlertDescription>{t('patient.visits.calendar.inactiveResourceBody')}</AlertDescription>
            </Alert>
          ) : null}
          {access.canManage ? null : (
            <Alert status="information">
              <AlertTitle>{t('patient.visits.calendar.readOnlyTitle')}</AlertTitle>
              <AlertDescription>{t('patient.visits.calendar.readOnlyBody')}</AlertDescription>
            </Alert>
          )}
          {query.data?.items.length === 0 ? (
            <EmptyState
              title={t('patient.visits.calendar.emptyTitle')}
              description={t('patient.visits.calendar.emptyBody')}
              actions={access.canManage ? (
                <Button type="button" onClick={() => openCreate()}>{t('patient.visits.actions.schedule')}</Button>
              ) : undefined}
            />
          ) : null}
          {query.data?.lanes.length ? (
            <section
              className="space-y-2 rounded-lg border bg-muted/30 p-3"
              aria-label={t('patient.visits.calendar.laneSummaryHeading')}
              data-visit-availability-lanes=""
            >
              <h2 className="text-sm font-medium">{t('patient.visits.calendar.laneSummaryHeading')}</h2>
              <ul className="space-y-2 text-sm">
                {query.data.lanes.map((lane) => (
                  <li key={`${lane.subjectType}:${lane.subjectId}`} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{lane.subjectName}</span>
                    {lane.windows.map((window) => (
                      <span key={window.id} className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                        <time dateTime={window.from}>
                          {laneWindowFormatter.formatRange(new Date(window.from), new Date(window.to))}
                        </time>
                        {' · '}
                        {window.kind === 'availability'
                          ? t('patient.visits.calendar.availableLane', undefined, { name: lane.subjectName })
                          : window.reasonLabel || t('patient.visits.calendar.unavailableLane', undefined, { name: lane.subjectName })}
                      </span>
                    ))}
                    {lane.windows.length === 0 ? (
                      <span className="text-muted-foreground">{t('patient.visits.calendar.noScheduleTitle')}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div ref={setScheduleRootRef}>
            <ScheduleView
              className="min-w-0 patient-visits-calendar"
              items={scheduleItems}
              view={state.view}
              range={state.range}
              timezone={state.timeZone}
              onRangeChange={(nextRange) => setState((current) => ({ ...current, range: nextRange }))}
              onViewChange={(view) => setState((current) => ({ ...current, view }))}
              onTimezoneChange={(timeZone) => setState((current) => ({
                ...current,
                timeZone: validTimeZone(timeZone),
              }))}
              onSlotClick={access.canManage ? openCreate : undefined}
              onItemClick={(item) => {
                const visitId = item.metadata?.itemType === 'visit' && typeof item.metadata.visitId === 'string'
                  ? item.metadata.visitId
                  : null
                if (visitId) setDialog({ mode: 'edit', visitId })
              }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground" aria-live="polite">
            <span>{t('patient.visits.calendar.count', undefined, { count: query.data?.items.length ?? 0 })}</span>
            <div className="flex flex-wrap items-center gap-2" aria-label={t('patient.visits.calendar.legend')}>
              <StatusBadge variant="info" appearance="light">{t('patient.visits.status.planned')}</StatusBadge>
              <StatusBadge variant="success" appearance="light">{t('patient.visits.status.completed')}</StatusBadge>
              <StatusBadge variant="warning" appearance="light">{t('patient.visits.status.no_show')}</StatusBadge>
              <StatusBadge variant="neutral" appearance="light">{t('patient.visits.status.cancelled')}</StatusBadge>
            </div>
          </div>
        </>
      )}

      <VisitCalendarDialog
        state={dialog}
        onClose={() => setDialog(null)}
        onSaved={invalidateVisits}
        onChanged={invalidateVisits}
      />
    </div>
  )
}

export default VisitsCalendar
