import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'
import extensionPoints from '../extension-points'
import en from '../i18n/en.json'
import pl from '../i18n/pl.json'

const read = (...segments: string[]) => readFileSync(path.join(__dirname, '..', ...segments), 'utf8')

describe('patient visit UI contracts', () => {
  it('publishes stable extension hosts for the list and form', () => {
    expect(extensionPoints.hosts.visitsTable.tableId).toBe('patient.visits.list')
    expect(extensionPoints.hosts.visitsTable.family).toBe('data-table')
    expect(extensionPoints.hosts.visitForm.entityId).toBe('patient.patient_visit')
    expect(extensionPoints.hosts.visitForm.spotId).toBe('crud-form:patient.visit')
  })

  it('keeps visit translations complete and in parity', () => {
    const sources = [
      read('components', 'VisitForm.tsx'),
      read('components', 'VisitLifecycleActions.tsx'),
      read('components', 'VisitAvailabilityCheck.tsx'),
      read('components', 'VisitsCalendar.tsx'),
      read('components', 'VisitsTable.tsx'),
      read('components', 'VisitServicesField.tsx'),
    ].join('\n')
    const keys = Array.from(sources.matchAll(/t\('([^']+)'/g), (match) => match[1])
      .filter((key) => key.startsWith('patient.visits.') && !key.endsWith('.'))
    for (const key of keys) {
      expect((en as Record<string, string>)[key]).toBeTruthy()
      expect((pl as Record<string, string>)[key]).toBeTruthy()
    }
    expect(Object.keys(en).filter((key) => key.startsWith('patient.visits.')).sort())
      .toEqual(Object.keys(pl).filter((key) => key.startsWith('patient.visits.')).sort())
  })

  it('reuses one debounced availability gate and renders the override audit without UUIDs', () => {
    const availability = read('components', 'VisitAvailabilityCheck.tsx')
    const form = read('components', 'VisitForm.tsx')
    const access = read('components', 'usePatientVisitAccess.ts')
    const route = read('api', 'visits', 'route.ts')
    expect(availability).toContain("['patient.visits', 'availability-check', debouncedUrl]")
    expect(availability).toContain('window.setTimeout(() => setDebouncedUrl(probeUrl), 300)')
    expect(availability).toContain('acknowledgedSignatures: Array.from(new Set(')
    expect(availability).toContain('event.metaKey || event.ctrlKey')
    expect(form).toContain('<VisitAvailabilityCheck')
    expect(form).toContain('<VisitConflictOverrideAudit visit={record} />')
    expect(form).not.toContain('{visit.conflictOverrideByUserId}')
    expect(access).toContain("'patient.visits.override_conflict'")
    expect(route).toContain('references.resolveUsers(overrideUserIds')
  })

  it('reuses the VIS editor in a keyboard-accessible calendar dialog', () => {
    const form = read('components', 'VisitForm.tsx')
    expect(form).toContain('export function VisitCalendarDialog')
    expect(form).toContain('<VisitCreateForm')
    expect(form).toContain('<VisitDetailForm')
    expect(form).toContain('embedded={embedded}')
    expect(form).toContain('trackDirtyWhenEmbedded={embedded}')
    expect(form).toContain("customFieldsManageMode={embedded ? 'page' : 'inline'}")
    expect(form).toContain('form.requestSubmit()')
    expect(form).toContain('event.metaKey || event.ctrlKey')
    expect(form).toContain('startsAtLocal: startsAt ? toVisitLocalDateTime(startsAt, timeZone)')
    expect(form).toContain('await onSaved?.()')
  })

  it('builds the calendar on the public schedule surface with timezone-safe URL state', () => {
    const calendar = read('components', 'VisitsCalendar.tsx')
    const table = read('components', 'VisitsTable.tsx')
    const pageMeta = read('backend', 'patient', 'visits', 'calendar', 'page.meta.ts')
    expect(calendar).toContain("from '@open-mercato/ui/backend/schedule'")
    expect(calendar).toContain('toZonedTime(new Date(value), timeZone)')
    expect(calendar).toContain('fromZonedTime(normalized.start, state.timeZone)')
    expect(calendar).toContain("queryKey: ['patient.visits', 'calendar', queryString, scopeVersion]")
    expect(calendar).toContain("next.set('from', serializedRange.from)")
    expect(calendar).toContain("next.set('view', state.view)")
    expect(calendar).toContain("next.set('timeZone', state.timeZone)")
    expect(calendar).toContain('enabled: access.status === \'ready\' && access.canView && !rangeTooWide')
    expect(calendar).toContain("linkLabel: t('patient.visits.actions.open')")
    expect(calendar).toContain("onSlotClick={access.canManage ? openCreate : undefined}")
    expect(calendar).toContain("state.view === 'month'")
    expect(calendar).toContain('<VisitCalendarDialog')
    expect(table).toContain("t('patient.visits.actions.calendar')")
    expect(table).toContain("t('patient.visits.actions.showInCalendar')")
    expect(pageMeta).toContain("icon: 'calendar'")
    expect(pageMeta).toContain('pagePriority: 10')
  })

  it('pins immutable patients, versioned mutations, snapshots, and owner suggestions', () => {
    const form = read('components', 'VisitForm.tsx')
    const teamMember = read('components', 'VisitTeamMemberField.tsx')
    const services = read('components', 'VisitServicesField.tsx')
    expect(form).toContain('disabled: patientReadOnly')
    expect(form).toContain('expectedUpdatedAt: values.updatedAt ?? record.updatedAt')
    expect(form).toContain('optimisticLockUpdatedAt={record.updatedAt}')
    expect(form).toContain('historicalOption={referenceSeeds?.teamMember}')
    expect(form).toContain("patientId={typeof values?.patientId")
    expect(teamMember).toContain("'visit-owner-suggestion'")
    expect(services).toContain('service.isAvailable')
    expect(services).not.toContain('Promise.all(unchecked.map')
    expect(services).toContain("t('patient.common.unavailableReference')")
  })

  it('pins fail-closed feature probing to organization scope and responsive patient tabs', () => {
    const access = read('components', 'usePatientVisitAccess.ts')
    const detail = read('components', 'PatientDetail.tsx')
    expect(access).toContain('useOrganizationScopeDetail')
    expect(access).toContain('[organizationId, tenantId]')
    expect(access).toContain("status: 'unknown'")
    for (const permission of ['canView', 'canManage', 'canCorrect', 'canSettle']) {
      expect(access).toContain(`${permission}: false`)
    }
    expect(detail).toContain("resolvedTab === 'visits'")
    expect(detail).toContain('overflow-x-auto')
  })

  it('keeps lifecycle actions guarded, versioned, accessible, and outside the read-only form body', () => {
    const form = read('components', 'VisitForm.tsx')
    const actions = read('components', 'VisitLifecycleActions.tsx')
    expect(form).toContain('<VisitLifecycleActions')
    expect(form).toContain('contentHeader={(')
    expect(actions).toContain('useGuardedMutation<')
    expect(actions).toContain('readApiResultOrThrow<VisitLifecycleResult>')
    expect(actions).toContain('const requestPayload = { ...payload, expectedUpdatedAt: visit.updatedAt }')
    expect(actions).toContain("resourceKind: 'patient.visit'")
    expect(actions).toContain('retryLastMutation,')
    expect(actions).toContain("value.code !== 'version_conflict'")
    expect(actions).toContain('showRecordConflict({')
    expect(actions).toContain('onRefresh: () => { void onSaved() }')
    expect(actions).toContain('maxLength={2000}')
    expect(actions).toContain('event.metaKey || event.ctrlKey')
    expect(actions).toContain('onCloseAutoFocus=')
    expect(actions).toContain('role="status" aria-live="polite"')
    expect(actions).toContain('data-confirmation-reset-warning')
  })

  it('uses a strict patient sort allowlist and guards the visit projection', () => {
    const route = read('api', 'patients', 'route.ts')
    expect(route).toContain("'nextVisit',")
    expect(route).toContain('tiebreakSortField: idField')
    expect(route).toContain("if (_query.sortField === 'nextVisit')")
    expect(route).not.toContain('sortField: z.string()')
    expect(route).toContain("entityType: ENTITY_ID")
    expect(route).toContain('resolvePatientEncryptedFieldIds')
  })
})
