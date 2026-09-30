"use client"
import * as React from 'react'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import extensionPoints from '../extension-points'
import { loadTeamMemberOptions, resolveTeamMemberLabel } from './referencePickers'
import { CountrySelectField } from './CountrySelectField'
import {
  PatientContactsDraftField,
  createEmptyContactDraft,
  isContactDraftComplete,
  type PatientContactDraft,
} from './PatientContactsDraftField'

const LIST_HREF = '/backend/patient/patients'

/**
 * Derived from the declared host rather than repeated, because the fact extractor only
 * records a host as BOUND when its declared source file reads `extensionPoints.hosts.<key>`.
 * `CrudForm` normalizes the colon form back to the host's dotted `entityId`.
 */
const ENTITY_ID = extensionPoints.hosts.patientForm.entityId.replace('.', ':')

type Translate = ReturnType<typeof useT>

type AccessibleTextFieldOptions = {
  id: string
  label: string
  required?: boolean
  description?: React.ReactNode
  maxLength?: number
  textarea?: boolean
  rows?: number
  showCount?: boolean
}

/**
 * Builds a text control whose visible label is programmatically associated with its input.
 *
 * The installed CrudForm currently renders built-in text/textarea labels without an
 * `htmlFor`, so clicking the label does not focus the control and assistive technology cannot
 * derive its accessible name. Keeping the field as a CrudForm custom field preserves its
 * validation and group membership while letting the app render the shared FormField primitive
 * around the shared Input/Textarea controls. The blank outer label prevents a second,
 * unassociated label from being rendered by CrudForm.
 */
function accessibleTextField({
  id,
  label,
  required = false,
  description,
  maxLength,
  textarea = false,
  rows,
  showCount = false,
}: AccessibleTextFieldOptions): CrudField {
  const controlId = `patient-create-${id}`
  return {
    id,
    label: '',
    type: 'custom',
    required,
    rendersOwnError: true,
    component: ({ value, setValue, error, autoFocus, disabled }) => (
      <FormField
        id={controlId}
        label={label}
        required={required}
        description={description}
        error={error}
        disabled={disabled}
      >
        {textarea ? (
          <Textarea
            value={value == null ? '' : String(value)}
            onChange={(event) => setValue(event.target.value)}
            autoFocus={autoFocus}
            disabled={disabled}
            required={required}
            maxLength={maxLength}
            rows={rows}
            showCount={showCount}
          />
        ) : (
          <Input
            value={value == null ? '' : String(value)}
            onChange={(event) => setValue(event.target.value)}
            autoFocus={autoFocus}
            disabled={disabled}
            required={required}
            maxLength={maxLength}
          />
        )}
      </FormField>
    ),
  }
}

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
  /**
   * Guardians, contacts and payers entered alongside the record.
   *
   * Held as one form value rather than flattened fields because the count is open-ended. They
   * are submitted with the patient and written in the same transaction, so a child's parent is
   * recorded at the moment it is known instead of on a second screen.
   */
  contacts: PatientContactDraft[]
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
      accessibleTextField({
        id: 'firstName',
        label: t('patient.patients.fields.firstName'),
        required: true,
        maxLength: 120,
      }),
      accessibleTextField({
        id: 'lastName',
        label: t('patient.patients.fields.lastName'),
        required: true,
        maxLength: 120,
      }),
      {
        id: 'birthDate',
        label: t('patient.patients.fields.birthDate'),
        type: 'date',
        // The server validates this too; the picker's bound just stops the obvious mistake
        // before a round trip.
        maxDate: new Date(),
      },
      accessibleTextField({
        id: 'email',
        label: t('patient.patients.fields.email'),
        description: t('patient.patients.fields.contactHint'),
      }),
      accessibleTextField({
        id: 'phone',
        label: t('patient.patients.fields.phone'),
        description: t('patient.patients.fields.phoneHint'),
      }),
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
      accessibleTextField({
        id: 'description',
        label: t('patient.patients.fields.description'),
        description: t('patient.patients.fields.descriptionHint'),
        maxLength: 20_000,
        textarea: true,
        showCount: true,
        rows: 4,
      }),
    ],
    [t],
  )
}

/**
 * The repeatable guardian editor, as a single custom field.
 *
 * `rendersOwnError` is not set: the field never produces a validation error of its own, because
 * an incomplete row is dropped on submit rather than blocking the save. The server still
 * enforces every invariant on what is actually sent.
 */
function useContactsField(): CrudField {
  return React.useMemo<CrudField>(
    () => ({
      id: 'contacts',
      // Intentionally blank. The enclosing group already renders "Guardians and contacts" as its
      // heading, and repeating it as a field label printed the same title twice, one above the
      // other. `CrudForm` skips a label whose trimmed length is zero, so this removes the
      // duplicate without leaving an empty element behind.
      label: '',
      type: 'custom',
      component: ({ value, setValue, values, setFormValue }) => (
        <PatientContactsDraftField
          value={Array.isArray(value) ? (value as PatientContactDraft[]) : []}
          onChange={(next) => setValue(next)}
          // Lets a chosen guardian seed the patient's own empty email/phone, without ever
          // overwriting something the operator typed.
          formValues={values}
          setFormValue={setFormValue}
        />
      ),
    }),
    [],
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
      accessibleTextField({ id: 'address_name', label: t('patient.patients.address.name'), maxLength: 120 }),
      accessibleTextField({ id: 'address_purpose', label: t('patient.patients.address.purpose'), maxLength: 60 }),
      accessibleTextField({
        id: 'address_addressLine1',
        label: t('patient.patients.address.line1'),
        required: true,
        maxLength: 200,
      }),
      accessibleTextField({ id: 'address_addressLine2', label: t('patient.patients.address.line2'), maxLength: 200 }),
      accessibleTextField({ id: 'address_buildingNumber', label: t('patient.patients.address.buildingNumber'), maxLength: 40 }),
      accessibleTextField({ id: 'address_flatNumber', label: t('patient.patients.address.flatNumber'), maxLength: 40 }),
      accessibleTextField({ id: 'address_city', label: t('patient.patients.address.city'), required: true, maxLength: 120 }),
      accessibleTextField({ id: 'address_region', label: t('patient.patients.address.region'), maxLength: 120 }),
      accessibleTextField({ id: 'address_postalCode', label: t('patient.patients.address.postalCode'), maxLength: 20 }),
      {
        id: 'address_country',
        label: t('patient.patients.address.country'),
        // A picker over the installed ISO country dictionary, with flags, rather than a
        // two-letter text box the operator has to know the code for.
        type: 'custom',
        required: true,
        component: ({ value, setValue }) => (
          <CountrySelectField
            value={typeof value === 'string' ? value : ''}
            onChange={(next) => setValue(next)}
          />
        ),
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
  const contactsField = useContactsField()
  const fields = React.useMemo(
    () => [...identityFields, ...addressFields, contactsField],
    [identityFields, addressFields, contactsField],
  )

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
        id: 'contacts',
        title: t('patient.patients.groups.contacts'),
        column: 1,
        fields: ['contacts'],
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
      // One empty guardian row up front, because that is the common case for a child in care.
      // It is dropped on submit if left untouched, so an adult patient with no guardian costs
      // the operator nothing.
      contacts: [createEmptyContactDraft()],
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
          // Incomplete rows are dropped rather than refused: leaving a half-filled guardian row
          // behind is a normal way to finish this form, and it must not block the patient from
          // being created. The server re-validates every row that is actually sent.
          contacts: (Array.isArray(values.contacts) ? values.contacts : [])
            .filter(isContactDraftComplete)
            .map((draft) => ({
              customerEntityId: draft.customerEntityId,
              isGuardian: draft.isGuardian,
              isContact: draft.isContact,
              isPayer: draft.isPayer,
              isPrimaryContact: draft.isPrimaryContact,
              relationshipLabel: draft.relationshipLabel.trim().length > 0
                ? draft.relationshipLabel.trim()
                : null,
            })),
          clientRequestId,
          ...customFieldEntries,
        })
      }}
    />
  )
}
