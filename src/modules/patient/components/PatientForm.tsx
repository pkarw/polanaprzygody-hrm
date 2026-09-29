"use client"
import * as React from 'react'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import extensionPoints from '../extension-points'
import { loadTeamMemberOptions, resolveTeamMemberLabel } from './referencePickers'

const LIST_HREF = '/backend/patient/patients'

/**
 * Derived from the declared host rather than repeated, because the fact extractor only
 * records a host as BOUND when its declared source file reads `extensionPoints.hosts.<key>`.
 * `CrudForm` normalizes the colon form back to the host's dotted `entityId`.
 */
const ENTITY_ID = extensionPoints.hosts.patientForm.entityId.replace('.', ':')

type Translate = ReturnType<typeof useT>

/**
 * The create form's flat value shape.
 *
 * The API takes the first address as a NESTED `primaryAddress` object, because the record
 * and its address are written in one transaction. `CrudForm` fields are flat, so the address
 * inputs are prefixed `address_` here and reassembled in `onSubmit`. The alternative —
 * creating the patient and then posting an address — is exactly the non-atomic sequence the
 * spec forbids: a failure between the two would leave an active record with no address,
 * violating its own invariant with nothing obliged to repair it.
 */
export type PatientCreateFormValues = {
  firstName: string
  lastName: string
  birthDate: string | null
  email: string | null
  phone: string | null
  description: string | null
  ownerTeamMemberId: string | null
  address_name: string | null
  address_purpose: string | null
  address_addressLine1: string
  address_addressLine2: string | null
  address_buildingNumber: string | null
  address_flatNumber: string | null
  address_city: string
  address_region: string | null
  address_postalCode: string | null
  address_country: string
} & Record<`cf_${string}`, unknown>

/** Empty string from a cleared input means "no value", not the empty string. */
function orNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function useIdentityFields(t: Translate): CrudField[] {
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
      {
        id: 'birthDate',
        label: t('patient.patients.fields.birthDate'),
        type: 'date',
        // The server validates this too; the picker's bound just stops the obvious mistake
        // before a round trip.
        maxDate: new Date(),
      },
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
        // A searchable combobox rather than a plain select: staff lists are long, and the
        // operator must never type or read a uuid.
        type: 'combobox',
        description: t('patient.patients.fields.ownerTeamMemberHint'),
        loadOptions: loadTeamMemberOptions,
        // Resolves a stored value whose row is not on the first page of results, and a
        // carer who has since been deactivated, so the field shows a name rather than
        // going blank.
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

/**
 * The first-address fields.
 *
 * City and country are `required` here and optional on later addresses, mirroring the API:
 * the first address is the one the record is reachable by. The postal code stays optional
 * throughout — plenty of countries have none.
 */
function usePrimaryAddressFields(t: Translate): CrudField[] {
  return React.useMemo<CrudField[]>(
    () => [
      { id: 'address_name', label: t('patient.patients.address.name'), type: 'text', maxLength: 120 },
      { id: 'address_purpose', label: t('patient.patients.address.purpose'), type: 'text', maxLength: 60 },
      {
        id: 'address_addressLine1',
        label: t('patient.patients.address.line1'),
        type: 'text',
        required: true,
        maxLength: 200,
      },
      { id: 'address_addressLine2', label: t('patient.patients.address.line2'), type: 'text', maxLength: 200 },
      { id: 'address_buildingNumber', label: t('patient.patients.address.buildingNumber'), type: 'text', maxLength: 40 },
      { id: 'address_flatNumber', label: t('patient.patients.address.flatNumber'), type: 'text', maxLength: 40 },
      { id: 'address_city', label: t('patient.patients.address.city'), type: 'text', required: true, maxLength: 120 },
      { id: 'address_region', label: t('patient.patients.address.region'), type: 'text', maxLength: 120 },
      { id: 'address_postalCode', label: t('patient.patients.address.postalCode'), type: 'text', maxLength: 20 },
      {
        id: 'address_country',
        label: t('patient.patients.address.country'),
        type: 'text',
        required: true,
        maxLength: 2,
        placeholder: t('patient.patients.address.countryPlaceholder'),
        description: t('patient.patients.address.countryHint'),
      },
    ],
    [t],
  )
}

/**
 * Creates a patient record together with its first address.
 *
 * `clientRequestId` is generated once per mounted form, not per submit. That is what makes
 * the idempotency key useful: a double-clicked save, or a retry after a network error that
 * actually committed, sends the SAME key and the server returns the record it already
 * created instead of a duplicate. Regenerating it per attempt would defeat the whole
 * mechanism, and generating it on the server would leave the client with no way to identify
 * its own retry.
 */
export function PatientCreateForm() {
  const t = useT()
  const identityFields = useIdentityFields(t)
  const addressFields = usePrimaryAddressFields(t)
  const fields = React.useMemo(() => [...identityFields, ...addressFields], [identityFields, addressFields])

  const clientRequestId = React.useMemo(() => crypto.randomUUID(), [])

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
      {
        id: 'primaryAddress',
        title: t('patient.patients.groups.primaryAddress'),
        column: 2,
        fields: [
          'address_name',
          'address_purpose',
          'address_addressLine1',
          'address_buildingNumber',
          'address_flatNumber',
          'address_addressLine2',
          'address_postalCode',
          'address_city',
          'address_region',
          'address_country',
        ],
      },
      {
        id: 'custom',
        title: t('patient.patients.groups.custom'),
        column: 2,
        kind: 'customFields',
      },
    ],
    [t],
  )

  const initialValues = React.useMemo<Partial<PatientCreateFormValues>>(
    () => ({
      firstName: '',
      lastName: '',
      birthDate: null,
      email: null,
      phone: null,
      description: null,
      ownerTeamMemberId: null,
      address_addressLine1: '',
      address_city: '',
      // Pre-filling a country would quietly decide a fact about the patient; the operator
      // enters it, and the field says what format is expected.
      address_country: '',
    }),
    [],
  )

  const successRedirect = React.useMemo(
    () => `${LIST_HREF}?flash=${encodeURIComponent(t('patient.patients.flash.created'))}&type=success`,
    [t],
  )

  return (
    <CrudForm<PatientCreateFormValues>
      title={t('patient.patients.create.title')}
      titleHeadingLevel={1}
      backHref={LIST_HREF}
      entityId={ENTITY_ID}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={t('patient.patients.actions.save')}
      cancelHref={LIST_HREF}
      successRedirect={successRedirect}
      onSubmit={async (values) => {
        const record = values as Record<string, unknown>
        // Custom-field keys pass through untouched: the route splits `cf_*` out of the body
        // and the command writes them through the Data Engine after the transaction commits.
        const customFieldEntries = Object.fromEntries(
          Object.entries(record).filter(([key]) => key.startsWith('cf_')),
        )
        await createCrud('patient/patients', {
          firstName: values.firstName,
          lastName: values.lastName,
          birthDate: orNull(values.birthDate),
          email: orNull(values.email),
          phone: orNull(values.phone),
          description: orNull(values.description),
          ownerTeamMemberId: orNull(values.ownerTeamMemberId),
          primaryAddress: {
            name: orNull(values.address_name),
            purpose: orNull(values.address_purpose),
            addressLine1: values.address_addressLine1,
            addressLine2: orNull(values.address_addressLine2),
            buildingNumber: orNull(values.address_buildingNumber),
            flatNumber: orNull(values.address_flatNumber),
            city: values.address_city,
            region: orNull(values.address_region),
            postalCode: orNull(values.address_postalCode),
            country: values.address_country,
          },
          clientRequestId,
          ...customFieldEntries,
        })
      }}
    />
  )
}
