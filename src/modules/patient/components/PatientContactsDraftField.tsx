"use client"
import * as React from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { CheckboxField } from '@open-mercato/ui/primitives/checkbox-field'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { loadCrmPersonOptions, resolveCrmPersonContact, resolveCrmPersonLabel } from './referencePickers'

/**
 * A draft guardian / contact / payer, as the create form holds it before the record exists.
 *
 * Kept as plain values rather than link rows, because none of these exist yet — they are
 * submitted with the patient and written in the same transaction.
 */
export type PatientContactDraft = {
  customerEntityId: string
  isGuardian: boolean
  isContact: boolean
  isPayer: boolean
  isPrimaryContact: boolean
  relationshipLabel: string
}

export function createEmptyContactDraft(): PatientContactDraft {
  return {
    customerEntityId: '',
    // Guardian pre-checked: this control exists because a child in care arrives with a parent,
    // and that is the role being recorded the overwhelming majority of the time. Every flag
    // stays editable, and the server re-checks the invariants regardless.
    isGuardian: true,
    isContact: true,
    isPayer: false,
    isPrimaryContact: false,
    relationshipLabel: '',
  }
}

/** A draft is only submittable once a person is chosen and it carries at least one role. */
export function isContactDraftComplete(draft: PatientContactDraft): boolean {
  const hasRole = draft.isGuardian || draft.isContact || draft.isPayer
  const primaryIsConsistent = !draft.isPrimaryContact || draft.isContact
  return draft.customerEntityId.length > 0 && hasRole && primaryIsConsistent
}

/**
 * Repeatable guardian editor for the patient create form.
 *
 * Rendered as a `CrudForm` custom field rather than a set of flat fields, because the number of
 * guardians is not known in advance and a fixed "guardian 1 / guardian 2" pair would either
 * cap the real world or leave empty inputs on every form.
 *
 * Incomplete rows are dropped on submit rather than blocking the save: a half-filled guardian
 * row is a common way to leave a form, and refusing to create the patient over it would be
 * worse than recording the patient without that contact. The row shows what is missing while it
 * is on screen.
 */
export function PatientContactsDraftField({
  value,
  onChange,
  formValues,
  setFormValue,
}: {
  value: PatientContactDraft[]
  onChange: (next: PatientContactDraft[]) => void
  /** The enclosing form's current values, used to decide whether a field is still empty. */
  formValues?: Record<string, unknown>
  /** Writes into a sibling field of the enclosing form. */
  setFormValue?: (id: string, next: unknown) => void
}) {
  const t = useT()

  /**
   * Copies a newly chosen guardian's contact details into the patient's OWN empty fields.
   *
   * The spec permits a parent's contact details to be entered deliberately for a child, and
   * forbids fetching them dynamically *in place of* the patient's data. This is the first: a
   * one-time copy triggered by the operator picking that person, and only into a field that is
   * still empty. Anything the operator typed is never overwritten, nothing is re-read later, and
   * the copied values stay fully editable — the patient's fields remain the patient's own.
   */
  const seedPatientContactFrom = React.useCallback(
    async (customerEntityId: string) => {
      if (!customerEntityId || !setFormValue) return
      const emailIsEmpty = !String(formValues?.email ?? '').trim()
      const phoneIsEmpty = !String(formValues?.phone ?? '').trim()
      // Nothing to fill — skip the request entirely rather than fetching and discarding.
      if (!emailIsEmpty && !phoneIsEmpty) return
      try {
        const contact = await resolveCrmPersonContact(customerEntityId)
        if (!contact) return
        if (emailIsEmpty && contact.email) setFormValue('email', contact.email)
        if (phoneIsEmpty && contact.phone) setFormValue('phone', contact.phone)
      } catch {
        // Prefilling is a convenience; failing to read the person must not disturb the form the
        // operator is filling in.
      }
    },
    [formValues, setFormValue],
  )

  const update = React.useCallback(
    (index: number, patch: Partial<PatientContactDraft>) => {
      onChange(value.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)))
    },
    [onChange, value],
  )

  const setPrimary = React.useCallback(
    (index: number, checked: boolean) => {
      // At most one primary contact per patient. Checking one clears the others here rather
      // than letting the operator build a payload the server would refuse.
      onChange(
        value.map((draft, position) => ({
          ...draft,
          isPrimaryContact: checked ? position === index : position === index ? false : draft.isPrimaryContact,
        })),
      )
    },
    [onChange, value],
  )

  /** Ids already chosen in other rows, so the same person cannot be picked twice. */
  const takenIds = React.useMemo(
    () => value.map((draft) => draft.customerEntityId).filter((id) => id.length > 0),
    [value],
  )

  /**
   * Per-row option source.
   *
   * Each row searches on its own, so the query belongs to the control the operator is typing in
   * rather than to a separate box above the list — with one shared box it was never clear which
   * row a search applied to, and picking for a second guardian meant retyping.
   *
   * People already chosen in other rows are filtered out here rather than after selection, so the
   * duplicate the server would reject with a 409 is simply not offered.
   */
  const loadOptionsExcludingTaken = React.useCallback(
    async (selectedId: string, query?: string) => {
      try {
        const options = await loadCrmPersonOptions(query)
        return options.filter(
          (option) => option.value === selectedId || !takenIds.includes(option.value),
        )
      } catch {
        // An operator without `customers.people.view` gets an empty picker rather than an error:
        // the option source inherits the customers module's own ACL, and a patient with no
        // contacts is a valid record.
        return []
      }
    },
    [takenIds],
  )

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('patient.patients.contacts.draftHint')}</p>

      {value.map((draft, index) => {
        return (
          <div key={index} className="space-y-3 rounded-md border p-3">
            {/* `items-end` so the icon button sits on the select's baseline rather than floating
                level with the label above it. */}
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor={`patient-contact-draft-${index}`}>
                  {t('patient.patients.contacts.person')}
                </Label>
                {/* A searchable combobox rather than a plain select: the operator types into the
                    control they are filling in, and `allowCustomValues` stays off so the value is
                    always a real CRM id and never free text the server would reject. */}
                <ComboboxInput
                  value={draft.customerEntityId}
                  onChange={(next) => {
                    update(index, { customerEntityId: next })
                    void seedPatientContactFrom(next)
                  }}
                  placeholder={t('patient.patients.contacts.selectPerson')}
                  loadSuggestions={(query) => loadOptionsExcludingTaken(draft.customerEntityId, query)}
                  // Renders a already-chosen person by name on re-open, instead of leaving the
                  // control looking empty until it is searched again.
                  resolveLabel={resolveCrmPersonLabel}
                  allowCustomValues={false}
                  clearable
                  clearLabel={t('patient.patients.contacts.clearPerson')}
                />
              </div>
              {/* Icon-only, so it carries both an `aria-label` and a `title`: the guide requires
                  every icon-only control to be named for assistive tech, and the tooltip gives
                  sighted users the same word the text button used to show. */}
              <IconButton
                type="button"
                variant="outline"
                aria-label={t('patient.patients.contacts.removeDraft')}
                title={t('patient.patients.contacts.removeDraft')}
                onClick={() => onChange(value.filter((_, position) => position !== index))}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </IconButton>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <CheckboxField
                label={t('patient.patients.contacts.roles.guardian')}
                checked={draft.isGuardian}
                onCheckedChange={(checked) => update(index, { isGuardian: checked === true })}
              />
              <CheckboxField
                label={t('patient.patients.contacts.roles.contact')}
                checked={draft.isContact}
                onCheckedChange={(checked) =>
                  update(index, {
                    isContact: checked === true,
                    // Clearing "contact" cannot leave "primary contact" set — the table's check
                    // constraint forbids the combination.
                    isPrimaryContact: checked === true ? draft.isPrimaryContact : false,
                  })
                }
              />
              <CheckboxField
                label={t('patient.patients.contacts.roles.payer')}
                checked={draft.isPayer}
                onCheckedChange={(checked) => update(index, { isPayer: checked === true })}
              />
              <CheckboxField
                label={t('patient.patients.contacts.roles.primary')}
                checked={draft.isPrimaryContact}
                disabled={!draft.isContact}
                onCheckedChange={(checked) => setPrimary(index, checked === true)}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor={`patient-contact-draft-relationship-${index}`}>
                {t('patient.patients.contacts.relationshipLabel')}
              </Label>
              <Input
                id={`patient-contact-draft-relationship-${index}`}
                value={draft.relationshipLabel}
                maxLength={120}
                onChange={(event) => update(index, { relationshipLabel: event.target.value })}
                placeholder={t('patient.patients.contacts.relationshipPlaceholder')}
              />
            </div>

            {!isContactDraftComplete(draft) ? (
              // Stated, not enforced: an incomplete row is dropped on save rather than blocking
              // the patient from being created at all.
              <p className="text-xs text-muted-foreground" role="note">
                {t('patient.patients.contacts.draftIncomplete')}
              </p>
            ) : null}
          </div>
        )
      })}

      <Button type="button" variant="outline" onClick={() => onChange([...value, createEmptyContactDraft()])}>
        {t('patient.patients.contacts.addDraft')}
      </Button>
    </div>
  )
}

export default PatientContactsDraftField
