"use client"
import * as React from 'react'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { PHONE_COUNTRIES } from '@open-mercato/ui/backend/inputs/PhoneNumberField'
import { buildCountryOptions } from '@open-mercato/shared/lib/location/countries'
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

/** Flag emoji per ISO-3166 alpha-2 code, taken from the phone dictionary the UI already ships. */
const FLAG_BY_CODE = (() => {
  const flags = new Map<string, string>()
  for (const country of PHONE_COUNTRIES) {
    const iso2 = country.iso2.toUpperCase()
    if (!flags.has(iso2)) flags.set(iso2, country.flag)
  }
  return flags
})()

/**
 * The same country list, in the same order, with the same names as the address editor on the
 * patient card.
 *
 * `buildCountryOptions` is what that editor uses: it sorts the locale's common countries
 * first and resolves each name through `customers.countries.<code>`, so a Polish operator
 * reads "Polska". Building this list from the phone dictionary instead — as this field did —
 * showed English names ("Poland") on the create form and Polish ones two clicks later on the
 * same record, for the same field.
 *
 * The flag is still the phone dictionary's emoji: it needs no asset pipeline, scales with the
 * text, and is `aria-hidden` inside the option label so a screen reader announces the country
 * once. The stored value stays the uppercase two-letter code the API validates.
 */
function useCountryOptions(): Array<{ value: string; label: string }> {
  const t = useT()
  return React.useMemo(
    () =>
      buildCountryOptions({
        transformLabel: (code, fallback) => t(`customers.countries.${code.toLowerCase()}`, fallback ?? code),
      }).map((option) => {
        const flag = FLAG_BY_CODE.get(option.code)
        // "🇵🇱  Polska (PL)" — the code stays visible because it is what gets stored and what
        // an operator transcribing from a document is usually looking for.
        return {
          value: option.code,
          label: `${flag ? `${flag}  ` : ''}${option.label} (${option.code})`,
        }
      }),
    [t],
  )
}

export function CountrySelectField({ value, onChange, disabled }: CountrySelectFieldProps) {
  const t = useT()
  const options = useCountryOptions()

  const loadSuggestions = React.useCallback(
    async (query?: string) => {
      const term = query?.trim().toLocaleLowerCase() ?? ''
      if (term.length === 0) return options
      // Matches the name and the code, so both "pol" and "pl" find Poland.
      return options.filter((option) => option.label.toLocaleLowerCase().includes(term))
    },
    [options],
  )

  const resolveLabel = React.useCallback(
    (code: string) => {
      const match = options.find((option) => option.value === code.toUpperCase())
      // An unrecognized stored code renders as itself rather than blank, so an address
      // imported with an unusual code stays legible instead of looking unset.
      return match?.label ?? code
    },
    [options],
  )

  return (
    <ComboboxInput
      value={value ?? ''}
      // Uppercased on the way out to match the API's canonical form, so the column never holds
      // both "PL" and "pl" for the same country.
      onChange={(next) => onChange((next ?? '').toUpperCase())}
      placeholder={t('patient.patients.address.countryPlaceholder')}
      loadSuggestions={loadSuggestions}
      resolveLabel={resolveLabel}
      allowCustomValues={false}
      clearable={false}
      disabled={disabled}
    />
  )
}

export default CountrySelectField
