"use client"
import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@open-mercato/ui/primitives/tabs'
import { ErrorMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { deleteCrud, fetchCrudList, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { withFlash } from '@open-mercato/ui/backend/utils/flash'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { extractCustomFieldEntries } from '@open-mercato/shared/lib/crud/custom-fields-client'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import extensionPoints from '../extension-points'
import type { PatientDetailItem } from '../types'
import { loadTeamMemberOptions, resolveTeamMemberLabel } from './referencePickers'
import { PatientAddressesSection } from './PatientAddressesSection'
import { PatientContactsSection } from './PatientContactsSection'
import { PatientDiagnosesSection } from './PatientDiagnosesSection'
import { PatientDocumentsSection } from './PatientDocumentsSection'
import { PatientFilesSection } from './PatientFilesSection'
import { useClinicalAccess } from './useClinicalAccess'

const LIST_HREF = '/backend/patient/patients'
const ENTITY_ID = extensionPoints.hosts.patientForm.entityId.replace('.', ':')

/**
 * Tab ids. Kept in the URL so a reload, a bookmark or a shared link lands on the same tab —
 * and so a 409 that reloads the record does not silently drop the operator back to the first
 * tab.
 */
const TABS = ['data', 'addresses', 'contacts', 'diagnoses', 'documents', 'files'] as const
type TabId = (typeof TABS)[number]

/** Tabs that require `patient.clinical.view`; absent entirely for a records-only operator. */
const CLINICAL_TABS: readonly TabId[] = ['diagnoses', 'documents', 'files']

function isTabId(value: string | null): value is TabId {
  return value !== null && (TABS as readonly string[]).includes(value)
}

type Translate = ReturnType<typeof useT>

type PatientEditFormValues = {
  id: string
  firstName: string
  lastName: string
  birthDate: string | null
  email: string | null
  phone: string | null
  description: string | null
  ownerTeamMemberId: string | null
  /** Carries the optimistic-lock version into CrudForm for update AND delete. */
  updatedAt?: string | null
} & Record<`cf_${string}`, unknown>

function orNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Maps a loaded record into the edit form's values.
 *
 * Exported so the optimistic-lock wiring is testable: `CrudForm` derives the expected-version
 * header from `initialValues.updatedAt`, so dropping it here would silently disable conflict
 * detection for both update and delete while every other assertion still passed.
 */
export function toPatientFormValues(item: PatientDetailItem): PatientEditFormValues {
  const custom = extractCustomFieldEntries(item as PatientDetailItem & Record<string, unknown>)
  return {
    id: item.id,
    firstName: item.firstName ?? '',
    lastName: item.lastName ?? '',
    birthDate: item.birthDate,
    email: item.email,
    phone: item.phone,
    description: item.description,
    ownerTeamMemberId: item.ownerTeamMemberId,
    updatedAt: item.updatedAt,
    ...(custom as Record<`cf_${string}`, unknown>),
  }
}

export function PatientDetail({ id }: { id: string }) {
  const t = useT()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()

  const [record, setRecord] = React.useState<PatientDetailItem | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [isNotFound, setIsNotFound] = React.useState(false)
  const [isTransitioning, setIsTransitioning] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)

  const clinicalAccess = useClinicalAccess(id)
  // `unknown` keeps the clinical tabs hidden until the probe answers, so they do not flash in
  // and out for an operator who turns out not to hold the feature. `unavailable` shows them, so
  // a transport failure does not silently remove a surface the operator may be entitled to.
  const showClinicalTabs = clinicalAccess === 'granted' || clinicalAccess === 'unavailable'

  const requestedTab = searchParams?.get('tab') ?? null
  const resolvedTab: TabId = isTabId(requestedTab) ? requestedTab : 'data'
  // A deep link to a clinical tab the operator cannot open falls back to the record tab rather
  // than rendering an empty panel with no trigger to leave it.
  const activeTab: TabId =
    !showClinicalTabs && CLINICAL_TABS.includes(resolvedTab) ? 'data' : resolvedTab

  const setActiveTab = React.useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('tab', next)
      // `replace` rather than `push`: switching tabs is not a navigation step the operator
      // should have to walk back through to leave the record.
      router.replace(`${LIST_HREF}/${id}?${params.toString()}`, { scroll: false })
    },
    [id, router, searchParams],
  )

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      setLoadError(null)
      setIsNotFound(false)
      try {
        // A single-record read: this is the request shape that projects `description` and
        // `archivedAt`, which the list deliberately omits.
        const data = await fetchCrudList<PatientDetailItem>('patient/patients', {
          ids: id,
          pageSize: 1,
        })
        const item = data?.items?.[0]
        if (!item) {
          if (!cancelled) setIsNotFound(true)
          return
        }
        if (!cancelled) setRecord(item)
      } catch (error: unknown) {
        if (cancelled) return
        // 404 is "not visible in this scope", which for the operator is the same as
        // "does not exist" — deliberately indistinguishable, so an id cannot be probed.
        if ((error as { status?: number }).status === 404) setIsNotFound(true)
        else {
          setLoadError(
            error instanceof Error && error.message ? error.message : t('patient.patients.error.load'),
          )
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id, reloadToken, t])

  const fields = usePatientEditFields(t)

  const groups = React.useMemo<CrudFormGroup[]>(
    () => [
      {
        id: 'identity',
        title: t('patient.patients.groups.identity'),
        column: 1,
        fields: ['firstName', 'lastName', 'birthDate', 'ownerTeamMemberId'],
      },
      {
        id: 'contact',
        title: t('patient.patients.groups.contact'),
        column: 1,
        fields: ['email', 'phone', 'description'],
      },
      { id: 'custom', title: t('patient.patients.groups.custom'), column: 2, kind: 'customFields' },
    ],
    [t],
  )

  const fallbackValues = React.useMemo<PatientEditFormValues>(
    () => ({
      id,
      firstName: '',
      lastName: '',
      birthDate: null,
      email: null,
      phone: null,
      description: null,
      ownerTeamMemberId: null,
      updatedAt: null,
    }),
    [id],
  )

  const successRedirect = React.useMemo(
    () => withFlash(`${LIST_HREF}/${id}`, t('patient.patients.flash.saved'), 'success'),
    [id, t],
  )
  const deleteRedirect = React.useMemo(
    () => withFlash(LIST_HREF, t('patient.patients.flash.deleted'), 'success'),
    [t],
  )

  /**
   * Archives or restores through the dedicated endpoint.
   *
   * Not part of the form's submit: `status` is rejected by the generic PUT precisely so this
   * gate has one entry point. The record's current version travels with the request, so a
   * card left open while someone else edited it is told to reload rather than archiving a
   * state the operator never saw.
   */
  const toggleArchive = React.useCallback(
    async (archived: boolean) => {
      if (!record) return
      const confirmed = await confirm({
        title: archived
          ? t('patient.patients.confirm.archive.title')
          : t('patient.patients.confirm.restore.title'),
        description: archived
          ? t('patient.patients.confirm.archive.body')
          : t('patient.patients.confirm.restore.body'),
      })
      if (!confirmed) return
      setIsTransitioning(true)
      try {
        await withScopedApiRequestHeaders(buildOptimisticLockHeader(record.updatedAt), () =>
          apiCallOrThrow(`/api/patient/patients/${encodeURIComponent(record.id)}/archive`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ archived, expectedUpdatedAt: record.updatedAt }),
          }),
        )
        flash(
          archived ? t('patient.patients.flash.archived') : t('patient.patients.flash.restored'),
          'success',
        )
        reload()
      } catch (err) {
        if (surfaceRecordConflict(err, t)) {
          reload()
          return
        }
        flash(
          err instanceof Error && err.message ? err.message : t('patient.patients.error.load'),
          'error',
        )
      } finally {
        setIsTransitioning(false)
      }
    },
    [confirm, record, reload, t],
  )

  if (isNotFound) {
    return (
      <RecordNotFoundState
        label={t('patient.patients.error.notFound')}
        backHref={LIST_HREF}
        backLabel={t('patient.patients.actions.backToList')}
      />
    )
  }

  if (loadError) return <ErrorMessage label={loadError} />

  if (isLoading && !record) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" aria-live="polite">
        <Spinner className="size-4" />
        {t('patient.common.loading')}
      </div>
    )
  }

  // Narrowed to a non-null local before the nested callbacks below: TypeScript does not keep
  // state-property narrowing across closures.
  const loaded = record
  const isArchived = loaded?.status === 'archived'
  const initialValues = loaded ? toPatientFormValues(loaded) : fallbackValues

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold">
              {loaded?.displayName ?? t('patient.patients.detail.title')}
            </h1>
            <StatusBadge variant={isArchived ? 'neutral' : 'success'} dot>
              {t(`patient.patients.status.${isArchived ? 'archived' : 'active'}`)}
            </StatusBadge>
          </div>
          <p className="text-sm text-muted-foreground">{loaded?.patientNumber}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => router.push(LIST_HREF)}>
            {t('patient.patients.actions.backToList')}
          </Button>
          <Button
            variant="outline"
            disabled={!loaded || isTransitioning}
            onClick={() => void toggleArchive(!isArchived)}
          >
            {isArchived ? t('patient.patients.actions.restore') : t('patient.patients.actions.archive')}
          </Button>
        </div>
      </div>

      {isArchived ? (
        // States the consequence rather than just the status: history stays readable, new
        // entries are refused. That is exactly what the server enforces.
        <Alert variant="warning">{t('patient.patients.archivedNotice')}</Alert>
      ) : null}

      <Tabs value={activeTab} onValueChange={setActiveTab} variant="underline">
        <TabsList aria-label={t('patient.patients.detail.title')}>
          <TabsTrigger value="data">{t('patient.patients.tabs.data')}</TabsTrigger>
          <TabsTrigger value="addresses">{t('patient.patients.tabs.addresses')}</TabsTrigger>
          <TabsTrigger value="contacts">{t('patient.patients.tabs.contacts')}</TabsTrigger>
          {showClinicalTabs ? (
            <>
              <TabsTrigger value="diagnoses">{t('patient.patients.tabs.diagnoses')}</TabsTrigger>
              <TabsTrigger value="documents">{t('patient.patients.tabs.documents')}</TabsTrigger>
              <TabsTrigger value="files">{t('patient.patients.tabs.files')}</TabsTrigger>
            </>
          ) : null}
        </TabsList>

        <TabsContent value="data">
          <CrudForm<PatientEditFormValues>
            entityId={ENTITY_ID}
            fields={fields}
            groups={groups}
            initialValues={initialValues}
            submitLabel={t('patient.patients.actions.save')}
            cancelHref={LIST_HREF}
            successRedirect={successRedirect}
            deleteRedirect={deleteRedirect}
            isLoading={isLoading}
            loadingMessage={t('patient.common.loading')}
            // Archiving does not freeze the card's own fields — the spec keeps history
            // readable and allows correcting a mistyped name — but it does block the
            // sub-resources, which their own sections enforce.
            onSubmit={async (values) => {
              await updateCrud('patient/patients', {
                id: values.id,
                expectedUpdatedAt: values.updatedAt ?? null,
                firstName: values.firstName,
                lastName: values.lastName,
                // Explicit null clears; `undefined` would leave the column untouched, and
                // the two must not collapse.
                birthDate: orNull(values.birthDate),
                email: orNull(values.email),
                phone: orNull(values.phone),
                description: orNull(values.description),
                ownerTeamMemberId: orNull(values.ownerTeamMemberId),
                ...extractCustomFieldEntries(values as Record<string, unknown>),
              })
            }}
            onDelete={async () => {
              // `deleteCrud` carries the version in the body because `updatedAt` is not a
              // top-level delete option. A record with documentation is refused with a 409
              // naming archiving as the alternative.
              await deleteCrud('patient/patients', {
                id,
                body: { id, expectedUpdatedAt: initialValues.updatedAt ?? null },
              })
            }}
          />
        </TabsContent>

        <TabsContent value="addresses">
          <PatientAddressesSection patientId={id} readOnly={isArchived} onMutated={reload} />
        </TabsContent>

        <TabsContent value="contacts">
          <PatientContactsSection patientId={id} readOnly={isArchived} onMutated={reload} />
        </TabsContent>

        {showClinicalTabs ? (
          <>
            <TabsContent value="diagnoses">
              {/* `readOnly` blocks only NEW entries on an archived record. Correcting and voiding
                  stay available inside the section, because they repair history rather than add
                  to it — the same distinction the server enforces. */}
              <PatientDiagnosesSection patientId={id} readOnly={isArchived} onMutated={reload} />
            </TabsContent>
            <TabsContent value="documents">
              <PatientDocumentsSection patientId={id} readOnly={isArchived} onMutated={reload} />
            </TabsContent>
            <TabsContent value="files">
              {/* Present even though storage is disabled on this installation: an operator looking
                  for the feature needs to learn WHY it is absent, and a deployment that stored
                  links on a previously enabled host must still be able to detach them. */}
              <PatientFilesSection patientId={id} readOnly={isArchived} onMutated={reload} />
            </TabsContent>
          </>
        ) : null}
      </Tabs>

      {ConfirmDialogElement}
    </div>
  )
}

function usePatientEditFields(t: Translate): CrudField[] {
  return React.useMemo<CrudField[]>(
    () => [
      {
        id: 'firstName',
        label: t('patient.patients.fields.firstName'),
        type: 'text',
        required: true,
        maxLength: 120,
      },
      {
        id: 'lastName',
        label: t('patient.patients.fields.lastName'),
        type: 'text',
        required: true,
        maxLength: 120,
      },
      { id: 'birthDate', label: t('patient.patients.fields.birthDate'), type: 'date', maxDate: new Date() },
      {
        id: 'email',
        label: t('patient.patients.fields.email'),
        type: 'text',
        description: t('patient.patients.fields.contactHint'),
      },
      {
        id: 'phone',
        label: t('patient.patients.fields.phone'),
        type: 'text',
        description: t('patient.patients.fields.phoneHint'),
      },
      {
        id: 'ownerTeamMemberId',
        label: t('patient.patients.fields.ownerTeamMember'),
        type: 'combobox',
        description: t('patient.patients.fields.ownerTeamMemberHint'),
        loadOptions: loadTeamMemberOptions,
        // Without this, a stored carer whose row is not on the first page of results — or who
        // has since been deactivated — would render as a blank field rather than a name.
        resolveLabel: resolveTeamMemberLabel,
      },
      {
        id: 'description',
        label: t('patient.patients.fields.description'),
        type: 'textarea',
        description: t('patient.patients.fields.descriptionHint'),
        maxLength: 20_000,
        showCount: true,
        rows: 4,
      },
    ],
    [t],
  )
}

export default PatientDetail
