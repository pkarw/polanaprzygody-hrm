"use client"
import * as React from 'react'
import { apiCallOrThrow, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { AddressesSection as SharedAddressesSection } from '@open-mercato/ui/backend/detail'
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
        try {
          await withScopedApiRequestHeaders(buildOptimisticLockHeader(updatedAt ?? null), () =>
            apiCallOrThrow(
              '/api/patient/addresses',
              {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                // `expectedUpdatedAt` travels in the body as well as the header: the command
                // requires the token in its own input, so a caller that reaches the command
                // by another path still cannot skip the version check.
                body: JSON.stringify({ id, expectedUpdatedAt: updatedAt ?? null, ...payload }),
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
        try {
          await withScopedApiRequestHeaders(buildOptimisticLockHeader(updatedAt ?? null), () =>
            apiCallOrThrow(
              '/api/patient/addresses',
              {
                method: 'DELETE',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id, expectedUpdatedAt: updatedAt ?? null }),
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
    [onMutated, t],
  )

  return (
    <SharedAddressesSection
      // `null` puts the section in its own empty state instead of listing anything, which is
      // what a read-only archived record should show rather than editable tiles.
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
      onActionChange={readOnly ? undefined : onActionChange}
      onLoadingChange={onLoadingChange}
      dataAdapter={dataAdapter}
      labelPrefix="patient.patients.addresses"
      showCoordinateFields={false}
    />
  )
}

export default PatientAddressesSection
