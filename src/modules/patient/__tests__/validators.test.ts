import { describe, expect, it } from '@jest/globals'
import {
  countryCodeSchema,
  emailSchema,
  isoDateSchema,
  patientContactCreateSchema,
  patientContactUpdateSchema,
  patientCreateSchema,
  patientDiagnosisCreateSchema,
  patientUpdateSchema,
  phoneSchema,
  primaryAddressSchema,
} from '../data/validators'

/**
 * A deterministic, well-formed v4 UUID for test fixtures.
 *
 * The version nibble (`4`) and the variant nibble (`8`) are fixed on purpose: the schemas
 * use `z.string().uuid()`, which validates both, so a "looks like a uuid" string with
 * arbitrary nibbles is rejected and every assertion that happens to include an id would
 * fail for the wrong reason.
 */
const uuid = (n: number) => {
  const block = String(n % 10).repeat(8)
  return `${block}-aaaa-4bbb-8ccc-dddddddddddd`
}

const validPrimaryAddress = {
  addressLine1: 'Ulica Przykładowa 1',
  city: 'Wrocław',
  country: 'PL',
}

const validCreate = {
  firstName: 'Anna',
  lastName: 'Kowalska',
  email: 'anna@example.test',
  primaryAddress: validPrimaryAddress,
  clientRequestId: uuid(1),
}

describe('isoDateSchema', () => {
  it('accepts a real calendar date', () => {
    expect(isoDateSchema.parse('2026-02-28')).toBe('2026-02-28')
  })

  // A regex alone accepts 2026-02-31 and Date silently rolls it into March.
  it('rejects an impossible day rather than rolling it over', () => {
    expect(isoDateSchema.safeParse('2026-02-31').success).toBe(false)
  })

  it('rejects a non-ISO shape', () => {
    expect(isoDateSchema.safeParse('28.02.2026').success).toBe(false)
  })

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true)
    expect(isoDateSchema.safeParse('2026-02-29').success).toBe(false)
  })
})

describe('countryCodeSchema', () => {
  // Canonicalized on the way in, so the column never holds both 'PL' and 'pl' for the same
  // country — an exact-match filter would otherwise miss half the rows.
  it('uppercases a lowercase code', () => {
    expect(countryCodeSchema.parse('pl')).toBe('PL')
  })

  it('rejects anything that is not two letters', () => {
    expect(countryCodeSchema.safeParse('POL').success).toBe(false)
    expect(countryCodeSchema.safeParse('P').success).toBe(false)
    expect(countryCodeSchema.safeParse('12').success).toBe(false)
  })
})

describe('phoneSchema', () => {
  // Dropping the '+' would turn an international number into an ambiguous local one.
  it('keeps the country prefix and strips only typed separators', () => {
    expect(phoneSchema.parse('+48 123-456 789')).toBe('+48123456789')
  })

  it('treats an empty string as no value', () => {
    expect(phoneSchema.parse('')).toBeNull()
  })

  it('accepts an explicit null', () => {
    expect(phoneSchema.parse(null)).toBeNull()
  })

  it('rejects a value that is not a phone number', () => {
    expect(phoneSchema.safeParse('call me').success).toBe(false)
  })
})

describe('emailSchema', () => {
  it('lowercases and trims', () => {
    expect(emailSchema.parse('  Anna@Example.TEST ')).toBe('anna@example.test')
  })

  it('treats an empty string as no value', () => {
    expect(emailSchema.parse('')).toBeNull()
  })

  it('rejects a malformed address', () => {
    expect(emailSchema.safeParse('anna@').success).toBe(false)
  })
})

describe('primaryAddressSchema', () => {
  it('accepts the minimum the first address needs', () => {
    expect(primaryAddressSchema.parse(validPrimaryAddress)).toMatchObject({
      addressLine1: 'Ulica Przykładowa 1',
      city: 'Wrocław',
      country: 'PL',
    })
  })

  // The first address is the one the record is reachable by, so it must be complete.
  it('requires a city and a country', () => {
    expect(primaryAddressSchema.safeParse({ addressLine1: 'x', country: 'PL' }).success).toBe(false)
    expect(primaryAddressSchema.safeParse({ addressLine1: 'x', city: 'Wrocław' }).success).toBe(false)
  })

  // Plenty of countries have none, so this stays optional even on the first address.
  it('does not require a postal code', () => {
    expect(primaryAddressSchema.safeParse(validPrimaryAddress).success).toBe(true)
  })

  it('rejects a whitespace-only street', () => {
    expect(primaryAddressSchema.safeParse({ ...validPrimaryAddress, addressLine1: '   ' }).success).toBe(false)
  })

  it('normalizes a cleared optional field to null rather than an empty string', () => {
    // An empty string in an encrypted column still costs a ciphertext blob and reads back
    // as a value rather than as "not set".
    expect(primaryAddressSchema.parse({ ...validPrimaryAddress, region: '' }).region).toBeNull()
  })

  it('bounds the coordinates to real latitudes and longitudes', () => {
    expect(primaryAddressSchema.safeParse({ ...validPrimaryAddress, latitude: 91 }).success).toBe(false)
    expect(primaryAddressSchema.safeParse({ ...validPrimaryAddress, longitude: -181 }).success).toBe(false)
    expect(primaryAddressSchema.safeParse({ ...validPrimaryAddress, latitude: 51.1, longitude: 17.03 }).success).toBe(true)
  })
})

describe('patientCreateSchema', () => {
  it('accepts a record with an email only', () => {
    expect(patientCreateSchema.safeParse(validCreate).success).toBe(true)
  })

  it('accepts a record with a phone only', () => {
    const { email: _email, ...rest } = validCreate
    expect(patientCreateSchema.safeParse({ ...rest, phone: '+48123456789' }).success).toBe(true)
  })

  // The patient must have a contact channel of their own; a guardian's is recorded
  // deliberately in these fields, never fetched dynamically in their place.
  it('refuses a record with neither an email nor a phone', () => {
    const { email: _email, ...rest } = validCreate
    expect(patientCreateSchema.safeParse(rest).success).toBe(false)
  })

  it('treats an empty email and an empty phone as no contact channel at all', () => {
    expect(patientCreateSchema.safeParse({ ...validCreate, email: '', phone: '' }).success).toBe(false)
  })

  it('requires both name halves', () => {
    expect(patientCreateSchema.safeParse({ ...validCreate, firstName: '' }).success).toBe(false)
    expect(patientCreateSchema.safeParse({ ...validCreate, lastName: '   ' }).success).toBe(false)
  })

  it('requires the first address', () => {
    const { primaryAddress: _address, ...rest } = validCreate
    expect(patientCreateSchema.safeParse(rest).success).toBe(false)
  })

  it('requires an idempotency key', () => {
    const { clientRequestId: _key, ...rest } = validCreate
    expect(patientCreateSchema.safeParse(rest).success).toBe(false)
  })

  it('bounds the note', () => {
    expect(patientCreateSchema.safeParse({ ...validCreate, description: 'x'.repeat(20_001) }).success).toBe(false)
    expect(patientCreateSchema.safeParse({ ...validCreate, description: 'x'.repeat(20_000) }).success).toBe(true)
  })
})

describe('patientUpdateSchema', () => {
  const base = { id: uuid(2), expectedUpdatedAt: '2026-09-29T10:00:00.000Z' }

  // A missing version token has to be a 400, so it cannot be optional here.
  it('requires a version token', () => {
    expect(patientUpdateSchema.safeParse({ id: uuid(2), firstName: 'Anna' }).success).toBe(false)
  })

  it('accepts a patch that changes one field', () => {
    expect(patientUpdateSchema.safeParse({ ...base, firstName: 'Anna' }).success).toBe(true)
  })

  // undefined means "leave alone", null means "clear" — the command relies on the
  // difference, so parsing must preserve it.
  it('distinguishes an absent field from an explicit null', () => {
    const cleared = patientUpdateSchema.parse({ ...base, description: null })
    expect(cleared.description).toBeNull()
    const untouched = patientUpdateSchema.parse({ ...base })
    expect('description' in untouched && untouched.description !== undefined).toBe(false)
  })

  // The contact-channel rule is NOT re-checked here: clearing the email is legitimate when
  // a phone is already on record, and only the stored row can tell. The command enforces it.
  it('allows clearing the email on its own, leaving the merged check to the command', () => {
    expect(patientUpdateSchema.safeParse({ ...base, email: null }).success).toBe(true)
  })

  it('leaves the primary address out of the generic patch', () => {
    const parsed = patientUpdateSchema.parse({ ...base, primaryAddress: validPrimaryAddress } as Record<string, unknown>)
    expect('primaryAddress' in parsed).toBe(false)
  })
})

describe('patientContactCreateSchema', () => {
  const base = { patientId: uuid(3), customerEntityId: uuid(4) }

  it('requires at least one role', () => {
    expect(patientContactCreateSchema.safeParse(base).success).toBe(false)
  })

  it('accepts a single role', () => {
    expect(patientContactCreateSchema.safeParse({ ...base, isGuardian: true }).success).toBe(true)
  })

  // The roles are independent flags precisely so a guardian can also be the payer.
  it('accepts a guardian who is also the payer and the primary contact', () => {
    expect(
      patientContactCreateSchema.safeParse({
        ...base,
        isGuardian: true,
        isContact: true,
        isPayer: true,
        isPrimaryContact: true,
      }).success,
    ).toBe(true)
  })

  it('refuses a primary contact that is not a contact', () => {
    expect(
      patientContactCreateSchema.safeParse({ ...base, isPayer: true, isPrimaryContact: true }).success,
    ).toBe(false)
  })
})

describe('patientContactUpdateSchema', () => {
  const base = {
    id: uuid(5),
    expectedUpdatedAt: '2026-09-29T10:00:00.000Z',
    isGuardian: false,
    isContact: true,
    isPayer: false,
    isPrimaryContact: false,
  }

  it('accepts a complete set of flags', () => {
    expect(patientContactUpdateSchema.safeParse(base).success).toBe(true)
  })

  // The complete set is required so a partial update cannot silently drop a role and land
  // the row against its own check constraint.
  it('requires every flag rather than accepting a partial set', () => {
    const { isPayer: _dropped, ...partial } = base
    expect(patientContactUpdateSchema.safeParse(partial).success).toBe(false)
  })

  it('refuses a set with no role at all', () => {
    expect(patientContactUpdateSchema.safeParse({ ...base, isContact: false }).success).toBe(false)
  })

  // Re-pointing a link would rewrite who is recorded as guardian while keeping the audit
  // identity, so the person is not updatable.
  it('ignores an attempt to re-point the link at another person', () => {
    const parsed = patientContactUpdateSchema.parse({ ...base, customerEntityId: uuid(6) } as Record<string, unknown>)
    expect('customerEntityId' in parsed).toBe(false)
  })
})

describe('patientDiagnosisCreateSchema', () => {
  const base = {
    patientId: uuid(7),
    title: 'Ocena wstępna',
    description: 'Opis oceny.',
    diagnosedOn: '2026-09-28',
    clientRequestId: uuid(8),
  }

  it('accepts an entry with no code at all', () => {
    expect(patientDiagnosisCreateSchema.safeParse(base).success).toBe(true)
  })

  it('accepts a code together with its system', () => {
    expect(
      patientDiagnosisCreateSchema.safeParse({ ...base, code: 'F84.0', codeSystem: 'ICD-10' }).success,
    ).toBe(true)
  })

  // A code without its system is unresolvable, and a system without a code says nothing.
  it('refuses a code without its system', () => {
    expect(patientDiagnosisCreateSchema.safeParse({ ...base, code: 'F84.0' }).success).toBe(false)
  })

  it('refuses a system without its code', () => {
    expect(patientDiagnosisCreateSchema.safeParse({ ...base, codeSystem: 'ICD-10' }).success).toBe(false)
  })

  it('accepts a version alongside a code, and there is no dictionary check', () => {
    expect(
      patientDiagnosisCreateSchema.safeParse({
        ...base,
        code: 'made-up',
        codeSystem: 'local',
        codeVersion: '2026',
      }).success,
    ).toBe(true)
  })

  it('requires a title and a description', () => {
    expect(patientDiagnosisCreateSchema.safeParse({ ...base, title: '' }).success).toBe(false)
    expect(patientDiagnosisCreateSchema.safeParse({ ...base, description: '  ' }).success).toBe(false)
  })

  it('bounds the title and the description', () => {
    expect(patientDiagnosisCreateSchema.safeParse({ ...base, title: 'x'.repeat(251) }).success).toBe(false)
    expect(patientDiagnosisCreateSchema.safeParse({ ...base, description: 'x'.repeat(50_001) }).success).toBe(false)
  })
})
