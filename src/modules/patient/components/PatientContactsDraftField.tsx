"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { CheckboxField } from '@open-mercato/ui/primitives/checkbox-field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { CrudFieldOption } from '@open-mercato/ui/backend/CrudForm'
import { loadCrmPersonOptions } from './referencePickers'

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
}: {
  value: PatientContactDraft[]
  onChange: (next: PatientContactDraft[]) => void
}) {
  const t = useT()
  const [query, setQuery] = React.useState('')
  const [options, setOptions] = React.useState<CrudFieldOption[]>([])

  React.useEffect(() => {
    let cancelled = false
    loadCrmPersonOptions(query)
      .then((next) => {
        if (!cancelled) setOptions(next)
      })
      .catch(() => {
        // An operator without `customers.people.view` gets an empty picker rather than an
        // error: the option source inherits the customers module's own ACL, and a patient with
        // no contacts is a valid record.
        if (!cancelled) setOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [query])

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

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('patient.patients.contacts.draftHint')}</p>

      <div className="space-y-1">
        <Label htmlFor="patient-contact-draft-search">{t('patient.patients.contacts.searchPerson')}</Label>
        <Input
          id="patient-contact-draft-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('patient.patients.contacts.searchPerson')}
        />
      </div>

      {value.map((draft, index) => {
        const available = options.filter(
          (option) => option.value === draft.customerEntityId || !takenIds.includes(option.value),
        )
        return (
          <div key={index} className="space-y-3 rounded-md border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor={`patient-contact-draft-${index}`}>
                  {t('patient.patients.contacts.person')}
                </Label>
                <Select
                  value={draft.customerEntityId}
                  onValueChange={(next) => update(index, { customerEntityId: next })}
                >
                  <SelectTrigger
                    id={`patient-contact-draft-${index}`}
                    aria-label={t('patient.patients.contacts.person')}
                  >
                    <SelectValue placeholder={t('patient.patients.contacts.selectPerson')} />
                  </SelectTrigger>
                  <SelectContent>
                    {available.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => onChange(value.filter((_, position) => position !== index))}
                // Icon-free text button so the control is self-describing without an aria-label.
              >
                {t('patient.patients.contacts.removeDraft')}
              </Button>
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
