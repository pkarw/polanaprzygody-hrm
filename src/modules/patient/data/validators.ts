import { z } from 'zod'

/**
 * Zod schemas for the `patient` module.
 *
 * These are the technical contract: shape, bounds, formats and the invariants that can
 * be decided from the payload alone. Everything that needs the database or the clock in
 * the organization's timezone — "is this reference active and in scope", "is this the
 * last active entry in the chain", "is `diagnosed_on` not in the future *here*" — is a
 * command concern and is enforced there, after the parent row is locked.
 *
 * Two conventions worth stating once:
 *
 * - **`undefined` and `null` mean different things** on every update schema.
 *   `undefined` (the key is absent) leaves the field alone; `null` clears it. That is
 *   why optional-and-clearable fields are `.nullish()` rather than `.optional()`, and
 *   why there is no PATCH route — PUT with this distinction already covers it.
 * - **`expectedUpdatedAt` is required, not optional**, on every mutation of an existing
 *   record. The spec makes a missing version token a 400 rather than a silent
 *   last-write-wins, so it cannot be `.optional()` here.
 */

/** Trimmed, bounded, non-empty text. Rejects whitespace-only input. */
const requiredText = (max: number) => z.string().trim().min(1).max(max)

/** Bounded text that may be explicitly cleared with `null`. */
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // An empty string from a cleared form field means "no value", not "the empty
    // string" — normalizing here keeps `''` out of an encrypted column, where it would
    // still cost a ciphertext blob and read back as a value.
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()

/**
 * ISO-8601 calendar date, `YYYY-MM-DD`.
 *
 * The regex alone is not enough: it accepts `2026-02-31`. The refine re-parses and
 * compares the round-trip so an impossible day is rejected rather than silently
 * rolling over into the next month.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) return false
    return parsed.toISOString().slice(0, 10) === value
  }, 'Not a valid calendar date')

/**
 * ISO-3166 alpha-2, uppercase.
 *
 * Uppercased before validation rather than after, so a form that submits `pl` is
 * accepted and stored canonically — the alternative is a column that holds both `PL`
 * and `pl` for the same country and an exact-match filter that misses half of them.
 */
export const countryCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'Expected an ISO-3166 alpha-2 country code'))

/**
 * A phone number that keeps its country prefix.
 *
 * Only the separators humans type are stripped. A leading `+` is preserved because
 * dropping it turns an international number into an ambiguous local one, which the spec
 * calls out directly.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? null : value.replace(/[\s()–—-]/g, '')))
  .nullable()
  .refine(
    (value) => value === null || /^\+?[0-9]{4,20}$/.test(value),
    'Expected a phone number, optionally with a country prefix',
  )

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .refine(
    (value) => value === null || z.string().email().safeParse(value).success,
    'Expected a valid email address',
  )

/**
 * Address fields shared by create and update, in the shared CRM editor's shape.
 *
 * `purpose` is bounded but not enumerated: the shared editor sources its vocabulary
 * from the host, and hard-coding a copy of that list here would drift the moment the
 * host adds a value.
 */
const addressFieldsSchema = z.object({
  name: clearableText(120).optional(),
  purpose: clearableText(60).optional(),
  companyName: clearableText(200).optional(),
  addressLine1: requiredText(200),
  addressLine2: clearableText(200).optional(),
  buildingNumber: clearableText(40).optional(),
  flatNumber: clearableText(40).optional(),
  city: clearableText(120).optional(),
  region: clearableText(120).optional(),
  postalCode: clearableText(20).optional(),
  country: countryCodeSchema.nullish(),
  latitude: z.coerce.number().min(-90).max(90).nullish(),
  longitude: z.coerce.number().min(-180).max(180).nullish(),
})

/**
 * The first address, created atomically with the patient.
 *
 * City and country are required here and optional on later addresses. The spec asks
 * for exactly that asymmetry: the first address is the one the record is reachable by,
 * so it must be complete, while a later "invoice address abroad" may legitimately be
 * partial. The postal code stays optional throughout — plenty of countries have none.
 */
export const primaryAddressSchema = addressFieldsSchema.extend({
  city: requiredText(120),
  country: countryCodeSchema,
})

/** At least one of email / phone must survive validation. */
function hasOwnContactChannel(value: { email?: string | null; phone?: string | null }): boolean {
  return Boolean(value.email) || Boolean(value.phone)
}

export const patientCreateSchema = z
  .object({
    firstName: requiredText(120),
    lastName: requiredText(120),
    birthDate: isoDateSchema.nullish(),
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    description: clearableText(20_000).optional(),
    ownerTeamMemberId: z.string().uuid().nullish(),
    primaryAddress: primaryAddressSchema,
    customFields: z.record(z.string(), z.unknown()).optional(),
    clientRequestId: z.string().uuid(),
  })
  .refine(hasOwnContactChannel, {
    message: 'Provide at least an email address or a phone number',
    path: ['email'],
  })

/**
 * Patient update.
 *
 * `primaryAddress` is absent on purpose — addresses have their own routed commands so
 * the primary switch can lock the aggregate and move both rows atomically. Accepting an
 * address here would give that invariant a second, unlocked entry point.
 *
 * `status`, `archivedAt`, `patientNumber` and every actor/scope column are absent too:
 * the spec requires the generic update to reject them with a 400 rather than ignore
 * them silently, which the route's strict parse does.
 *
 * The contact-channel rule is NOT re-checked here. It needs the stored row to decide
 * (clearing `email` is fine when a `phone` is already on record), so the command
 * enforces it against the merged result.
 */
export const patientUpdateSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
  firstName: requiredText(120).optional(),
  lastName: requiredText(120).optional(),
  birthDate: isoDateSchema.nullish(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  description: clearableText(20_000).optional(),
  ownerTeamMemberId: z.string().uuid().nullish(),
  customFields: z.record(z.string(), z.unknown()).optional(),
})

export const patientArchiveSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
  archived: z.boolean(),
})

export const patientDeleteSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

export const patientAddressCreateSchema = addressFieldsSchema.extend({
  patientId: z.string().uuid(),
  isPrimary: z.boolean().optional(),
})

export const patientAddressUpdateSchema = addressFieldsSchema.partial().extend({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
  /**
   * Turning this on promotes the address and demotes the current primary in one
   * transaction. Turning it *off* is not accepted — an active patient must always have
   * exactly one primary address, so the way to change which one it is is to promote
   * another, never to leave the record with none.
   */
  isPrimary: z.literal(true).optional(),
})

export const patientAddressDeleteSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

/** At least one role flag must be set, per the table's own check constraint. */
function hasAnyRole(value: { isGuardian?: boolean; isContact?: boolean; isPayer?: boolean }): boolean {
  return Boolean(value.isGuardian) || Boolean(value.isContact) || Boolean(value.isPayer)
}

/** `isPrimaryContact` is meaningless without `isContact`. */
function primaryImpliesContact(value: { isContact?: boolean; isPrimaryContact?: boolean }): boolean {
  return !value.isPrimaryContact || Boolean(value.isContact)
}

export const patientContactCreateSchema = z
  .object({
    patientId: z.string().uuid(),
    customerEntityId: z.string().uuid(),
    isGuardian: z.boolean().optional().default(false),
    isContact: z.boolean().optional().default(false),
    isPayer: z.boolean().optional().default(false),
    isPrimaryContact: z.boolean().optional().default(false),
    relationshipLabel: clearableText(120).optional(),
  })
  .refine(hasAnyRole, { message: 'Select at least one role', path: ['isContact'] })
  .refine(primaryImpliesContact, {
    message: 'A primary contact must also be a contact',
    path: ['isPrimaryContact'],
  })

/**
 * Contact update.
 *
 * The role flags are non-optional so a partial update can never silently drop a role:
 * the client sends the complete set it wants, and the two invariants are checked on
 * that set rather than on a merge the client cannot see. `customerEntityId` is absent —
 * re-pointing a link at a different person would rewrite who is recorded as a
 * guardian; that is an unlink plus a link, with both steps audited.
 */
export const patientContactUpdateSchema = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().min(1),
    isGuardian: z.boolean(),
    isContact: z.boolean(),
    isPayer: z.boolean(),
    isPrimaryContact: z.boolean(),
    relationshipLabel: clearableText(120).optional(),
  })
  .refine(hasAnyRole, { message: 'Select at least one role', path: ['isContact'] })
  .refine(primaryImpliesContact, {
    message: 'A primary contact must also be a contact',
    path: ['isPrimaryContact'],
  })

export const patientContactDeleteSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

/** A diagnosis code and its system are set together or not at all. */
function codePairIsConsistent(value: { code?: string | null; codeSystem?: string | null }): boolean {
  return Boolean(value.code) === Boolean(value.codeSystem)
}

const diagnosisContentSchema = z.object({
  title: requiredText(250),
  description: requiredText(50_000),
  diagnosedOn: isoDateSchema,
  code: clearableText(100).optional(),
  codeSystem: clearableText(100).optional(),
  /** Optional even with a code present; there is no dictionary validation in this version. */
  codeVersion: clearableText(50).optional(),
})

export const patientDiagnosisCreateSchema = diagnosisContentSchema
  .extend({
    patientId: z.string().uuid(),
    clientRequestId: z.string().uuid(),
  })
  .refine(codePairIsConsistent, {
    message: 'Provide a code and its system together, or neither',
    path: ['codeSystem'],
  })

/**
 * Correcting a diagnosis.
 *
 * This carries the full replacement content, not a patch, because the result is a new
 * immutable entry rather than an edit. `expectedUpdatedAt` is the version of the entry
 * being superseded, so two clinicians correcting the same entry cannot both win.
 */
export const patientDiagnosisCorrectSchema = diagnosisContentSchema
  .extend({
    expectedUpdatedAt: z.string().min(1),
    clientRequestId: z.string().uuid(),
  })
  .refine(codePairIsConsistent, {
    message: 'Provide a code and its system together, or neither',
    path: ['codeSystem'],
  })

export const patientDiagnosisVoidSchema = z.object({
  expectedUpdatedAt: z.string().min(1),
  reason: requiredText(2_000),
})

export const patientDocumentLinkCreateSchema = z.object({
  patientId: z.string().uuid(),
  documentId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
})

export const patientDocumentLinkNewSchema = z.object({
  patientId: z.string().uuid(),
  title: requiredText(250),
  clientRequestId: z.string().uuid(),
})

export const patientDocumentLinkResumeSchema = z.object({
  expectedUpdatedAt: z.string().min(1),
})

export const patientDocumentLinkDeleteSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

export const patientAttachmentLinkCreateSchema = z
  .object({
    patientId: z.string().uuid(),
    attachmentId: z.string().uuid(),
    diagnosisId: z.string().uuid().nullish(),
    clientRequestId: z.string().uuid(),
  })

export const patientAttachmentLinkDeleteSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

export type PatientCreateInput = z.infer<typeof patientCreateSchema>
export type PatientUpdateInput = z.infer<typeof patientUpdateSchema>
export type PatientAddressCreateInput = z.infer<typeof patientAddressCreateSchema>
export type PatientAddressUpdateInput = z.infer<typeof patientAddressUpdateSchema>
export type PatientContactCreateInput = z.infer<typeof patientContactCreateSchema>
export type PatientContactUpdateInput = z.infer<typeof patientContactUpdateSchema>
export type PatientDiagnosisCreateInput = z.infer<typeof patientDiagnosisCreateSchema>
export type PatientDiagnosisCorrectInput = z.infer<typeof patientDiagnosisCorrectSchema>
