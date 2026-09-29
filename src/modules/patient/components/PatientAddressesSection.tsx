"use client"
import * as React from 'react'
import { apiCallOrThrow, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { AddressesSection as SharedAddressesSection } from '@open-mercato/ui/backend/detail'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Button } from '@open-mercato/ui/primitives/button'
import type { AddressDataAdapter, SectionAction } from '@open-mercato/ui/backend/detail'
import { createTranslatorWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { PatientAddressItem, PatientPagedResponse } from '../types'

/**
 * The patient card's addresses tab.
 *
 * This is the SAME `AddressesSection` component the CRM person card uses, driven by an
 * adapter pointing at this module's own endpoints. The spec is specific about why it is not
 * the same *data*: `customer_addresses` has a foreign key to `CustomerEntity`, and a patient
 * need not be a CRM person at all, so pushing a patient id through
 * `/api/customers/addresses` would violate that route's contract. Reusing the component
 * while owning the table is the point — the operator gets the editor they already know, and
 * clinical data stays out of CRM.
 *
 * The adapter is thin because this module's API already returns the exact `AddressSummary`
 * shape in camelCase, with coordinates decoded to numbers.
 *
 * `showCoordinateFields` is off: the spec lists geocoding as a non-goal and nothing in the
 * patient flow reads a coordinate, so exposing the inputs would invite entering data no
 * surface uses.
 */
export type PatientAddressesSectionProps = {
  patientId: string
  /** Disables mutations for an archived record, which accepts no new entries. */
  readOnly?: boolean
  onActionChange?: (action: SectionAction | null) => void
  onLoadingChange?: (isLoading: boolean) => void
  /** Called after any successful mutation so the parent can refresh the record's version. */
  onMutated?: () => void
}

export function PatientAddressesSection({
  patientId,
  readOnly = false,
  onActionChange,
  onLoadingChange,
  onMutated,
}: PatientAddressesSectionProps) {
  const tHook = useT()
  const t = React.useMemo(() => createTranslatorWithFallback(tHook), [tHook])

  /**
   * The shared section does not render its own "Add address" affordance — it REPORTS one
   * through `onActionChange` and leaves the host to place it. Without a host that renders
   * it, the tab has no way to add or edit an address at all, which is how this one shipped.
   *
   * It is rendered here rather than in `PatientDetail` so the addresses tab carries its own
   * header, count and description exactly like the contacts, diagnoses and documents tabs
   * do. `onActionChange` is still forwarded, so a host that wants to place the action
   * somewhere else can.
   */
  const [sectionAction, setSectionAction] = React.useState<SectionAction | null>(null)

  const handleActionChange = React.useCallback(
    (next: SectionAction | null) => {
      setSectionAction(next)
      onActionChange?.(next)
    },
    [onActionChange],
  )

  /**
   * The row's current version, re-read when the section does not have one.
   *
   * The shared section builds the tile for a freshly created address from the payload it
   * just submitted, and that object carries no `updatedAt` — so editing or deleting an
   * address without leaving the tab sent `expectedUpdatedAt: null` and the command refused
   * the write with a 400. Re-reading the row supplies the version the section never held.
   *
   * This is a read-then-write, but not a lost-update: the server still compares the token
   * under the row lock, so a value that went stale between the read and the write comes
   * back as a 409 the operator is told about, exactly as if the tile had carried it.
   */
  const resolveVersion = React.useCallback(
    async (id: string, updatedAt?: string | null): Promise<string | null> => {
      if (typeof updatedAt === 'string' && updatedAt.length > 0) return updatedAt
      try {
        const params = new URLSearchParams({ patientId, id, pageSize: '1' })
        const payload = await readApiResultOrThrow<PatientPagedResponse<PatientAddressItem>>(
          `/api/patient/addresses?${params.toString()}`,
        )
        return payload?.items?.[0]?.updatedAt ?? null
      } catch {
        // Let the write go ahead without a token: the command answers with the same
        // validation error it would have, rather than this read inventing a failure.
        return null
      }
    },
    [patientId],
  )

  const dataAdapter = React.useMemo<AddressDataAdapter>(
    () => ({
      list: async ({ entityId }) => {
        if (!entityId) return []
        const params = new URLSearchParams({ patientId: entityId, pageSize: '100' })
        const payload = await readApiResultOrThrow<PatientPagedResponse<PatientAddressItem>>(
          `/api/patient/addresses?${params.toString()}`,
          undefined,
          { errorMessage: t('patient.patients.addresses.error', 'Could not load the addresses.') },
        )
        return (payload?.items ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          purpose: item.purpose,
          companyName: item.companyName,
          addressLine1: item.addressLine1,
          addressLine2: item.addressLine2,
          buildingNumber: item.buildingNumber,
          flatNumber: item.flatNumber,
          city: item.city,
          region: item.region,
          postalCode: item.postalCode,
          country: item.country,
          latitude: item.latitude,
          longitude: item.longitude,
          isPrimary: item.isPrimary,
          updatedAt: item.updatedAt,
        }))
      },

      create: async ({ entityId, payload }) => {
        const response = await apiCallOrThrow<{ id?: string }>(
          '/api/patient/addresses',
          {
            // optimistic-lock-exempt: create has no prior version to compare against.
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patientId: entityId, ...payload }),
          },
          { errorMessage: t('patient.patients.addresses.error', 'Could not save the address.') },
        )
        onMutated?.()
        return response.result ?? {}
      },

      update: async ({ id, payload, updatedAt }) => {
        const version = await resolveVersion(id, updatedAt)
        try {
          await withScopedApiRequestHeaders(buildOptimisticLockHeader(version), () =>
            apiCallOrThrow(
              '/api/patient/addresses',
              {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                // `expectedUpdatedAt` travels in the body as well as the header: the command
                // requires the token in its own input, so a caller that reaches the command
                // by another path still cannot skip the version check.
                body: JSON.stringify({ id, expectedUpdatedAt: version, ...payload }),
              },
              { errorMessage: t('patient.patients.addresses.error', 'Could not save the address.') },
            ),
          )
          onMutated?.()
        } catch (err) {
          // Surfaces the shared conflict UI, then rethrows so the section keeps the
          // operator's input instead of treating the write as done.
          surfaceRecordConflict(err, t)
          throw err
        }
      },

      delete: async ({ id, updatedAt }) => {
        const version = await resolveVersion(id, updatedAt)
        try {
          await withScopedApiRequestHeaders(buildOptimisticLockHeader(version), () =>
            apiCallOrThrow(
              '/api/patient/addresses',
              {
                method: 'DELETE',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id, expectedUpdatedAt: version }),
              },
              // The server refuses the last address of an active record, and the primary one
              // while others remain. Both arrive as a 409 whose message names the remedy.
              { errorMessage: t('patient.patients.addresses.deleteError', 'Could not delete the address.') },
            ),
          )
          onMutated?.()
        } catch (err) {
          surfaceRecordConflict(err, t)
          throw err
        }
      },
    }),
    [onMutated, resolveVersion, t],
  )

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {/* No `count`: the shared section keeps its own list in state after a create or a
            delete and never re-runs the adapter's `list`, so a number rendered here would
            stop matching the tiles below it the moment the operator adds an address. */}
        <SectionHeader
          title={t('patient.patients.tabs.addresses', 'Addresses')}
          action={
            sectionAction && !readOnly ? (
              <Button onClick={sectionAction.onClick} disabled={sectionAction.disabled}>
                {sectionAction.label}
              </Button>
            ) : undefined
          }
        />
        <p className="text-sm text-muted-foreground">
          {t(
            'patient.patients.addresses.description',
            'An active record keeps exactly one primary address.',
          )}
        </p>
      </div>
      <SharedAddressesSection
        // `null` puts the section in its own empty state instead of listing anything, which
        // is what a read-only archived record should show rather than editable tiles.
        entityId={patientId}
        emptyLabel={t('patient.patients.addresses.empty', 'No addresses recorded.')}
        addActionLabel={t('patient.patients.addresses.add', 'Add address')}
        emptyState={{
          title: t('patient.patients.addresses.empty', 'No addresses recorded.'),
          actionLabel: t('patient.patients.addresses.add', 'Add address'),
          description: t(
            'patient.patients.addresses.emptyHint',
            'An active record keeps exactly one primary address.',
          ),
        }}
        translator={t}
        onActionChange={readOnly ? undefined : handleActionChange}
        onLoadingChange={onLoadingChange}
        dataAdapter={dataAdapter}
        labelPrefix="patient.patients.addresses"
        showCoordinateFields={false}
      />
    </div>
  )
}

export default PatientAddressesSection
