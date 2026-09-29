"use client"
import * as React from 'react'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { PHONE_COUNTRIES } from '@open-mercato/ui/backend/inputs/PhoneNumberField'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Country picker for an address, rendered with flags.
 *
 * The country list comes from `PHONE_COUNTRIES`, which the installed UI package already ships as a
 * complete ISO-3166 alpha-2 dictionary with a derived flag emoji. Reusing it rather than adding a
 * country package or hand-writing a list means no new dependency, no list to keep in sync, and the
 * same country names the phone field already shows.
 *
 * The flag is an emoji, not an image: it needs no asset pipeline, scales with the text, and is
 * marked `aria-hidden` so a screen reader announces the country name once rather than reading the
 * flag as a second, redundant label.
 *
 * The stored value stays the uppercase two-letter code the API validates — the flag and the name
 * are presentation only. `allowCustomValues` is off, so the operator cannot type a code that is
 * not a real country and get a 400 back from the server.
 */
export type CountrySelectFieldProps = {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
}

/** Deduplicated by iso2: the phone dictionary lists territories sharing a dial code separately. */
const COUNTRY_OPTIONS = (() => {
  const seen = new Set<string>()
  const options: Array<{ value: string; label: string }> = []
  for (const country of PHONE_COUNTRIES) {
    const iso2 = country.iso2.toUpperCase()
    if (seen.has(iso2)) continue
    seen.add(iso2)
    // "🇵🇱  Poland (PL)" — the code stays visible because it is what gets stored and what an
    // operator transcribing from a document is usually looking for.
    options.push({ value: iso2, label: `${country.flag}  ${country.label} (${iso2})` })
  }
  return options.sort((left, right) => left.label.localeCompare(right.label))
})()

function findLabel(code: string): string {
  const match = COUNTRY_OPTIONS.find((option) => option.value === code.toUpperCase())
  // An unrecognized stored code renders as itself rather than blank, so an address imported with
  // an unusual code is still legible instead of looking unset.
  return match?.label ?? code
}

export function CountrySelectField({ value, onChange, disabled }: CountrySelectFieldProps) {
  const t = useT()

  const loadSuggestions = React.useCallback(async (query?: string) => {
    const term = query?.trim().toLocaleLowerCase() ?? ''
    if (term.length === 0) return COUNTRY_OPTIONS
    // Matches the name and the code, so both "pol" and "pl" find Poland.
    return COUNTRY_OPTIONS.filter((option) => option.label.toLocaleLowerCase().includes(term))
  }, [])

  return (
    <ComboboxInput
      value={value ?? ''}
      // Uppercased on the way out to match the API's canonical form, so the column never holds
      // both "PL" and "pl" for the same country.
      onChange={(next) => onChange((next ?? '').toUpperCase())}
      placeholder={t('patient.patients.address.countryPlaceholder')}
      loadSuggestions={loadSuggestions}
      resolveLabel={findLabel}
      allowCustomValues={false}
      clearable={false}
      disabled={disabled}
    />
  )
}

export default CountrySelectField
