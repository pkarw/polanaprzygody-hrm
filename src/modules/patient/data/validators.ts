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

/**
 * A guardian / contact / payer supplied while creating the patient.
 *
 * Declared before `patientCreateSchema` because a child in care usually arrives with a parent,
 * and making the operator save the record and then open a second tab to record who the
 * guardian is loses that information exactly when it is at hand. The same invariants as the
 * standalone contact link apply, checked here so the payload is rejected before any row is
 * written rather than half-way through the transaction.
 */
export const patientCreateContactSchema = z
  .object({
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
    /**
     * Optional, because a patient may legitimately have no CRM contacts at all — the spec is
     * explicit about that, so an empty or absent list is a valid record rather than a skipped
     * step. The technical cap keeps one request bounded; it is not a domain limit.
     */
    contacts: z.array(patientCreateContactSchema).max(20).optional(),
    clientRequestId: z.string().uuid(),
  })
  .refine(hasOwnContactChannel, {
    message: 'Provide at least an email address or a phone number',
    path: ['email'],
  })
  // The patient must have their OWN channel even when a guardian is recorded here. A parent's
  // details may be entered into the patient's fields deliberately, but they are not fetched
  // from the guardian's CRM record in their place — that is the spec's rule, and this refine is
  // what stops the contact list from silently substituting for it.
  .refine(
    (value) => {
      const primaries = (value.contacts ?? []).filter((contact) => contact.isPrimaryContact)
      return primaries.length <= 1
    },
    { message: 'At most one contact can be the primary contact', path: ['contacts'] },
  )
  .refine(
    (value) => {
      const ids = (value.contacts ?? []).map((contact) => contact.customerEntityId)
      return new Set(ids).size === ids.length
    },
    { message: 'The same person cannot be linked twice', path: ['contacts'] },
  )

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
 *
 * Custom fields are absent from this schema and from `patientCreateSchema` on purpose:
 * the commands run the payload through `parseWithCustomFields`, which peels `cf_<key>`
 * entries (and a `customFields` object) off before the schema sees them. Declaring a
 * `customFields` key here as well would be dead — the splitter has already consumed it.
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

/**
 * Timestamp accepted by VIS: an ISO instant with an explicit UTC designator or offset.
 *
 * The leading `\d{4}-\d{2}-\d{2}` anchor rejects the ISO extended-year form
 * (`+275760-09-13T00:00:00Z`). Without it a caller could hand a span of ~1e8 days to the
 * planner rrule expander, which loops to `range.end` with no occurrence cap. The write path
 * already required a four-digit wall clock via `patientVisitInstantMatchesTimeZone`, so this
 * rejects nothing the write path previously accepted.
 */
export const patientVisitInstantSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/,
    'Expected an ISO-8601 timestamp with an explicit offset',
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Expected a valid timestamp')

/**
 * Longest span a single visit (or a single availability probe for one) may cover.
 *
 * Availability evaluation expands every planner rule across the requested span, so an
 * unbounded span is a denial-of-service vector rather than a merely odd request: one
 * `COUNT`-less daily rule over a year-9999 span expands to 2,912,443 windows, which blocks
 * the event loop for ~1.5s and allocates ~745MB per rule. 31 days is far longer than any
 * real visit while keeping the expansion bounded.
 */
export const PATIENT_VISIT_MAX_SPAN_MS = 31 * 24 * 60 * 60 * 1_000

/**
 * Longest span the standalone availability probe may be asked about.
 *
 * Tighter than `PATIENT_VISIT_MAX_SPAN_MS` on purpose. The probe answers "is this one slot
 * free", and the span it receives IS the window it reports back, so every unavailability
 * overlapping it is returned. A wide span therefore turns a slot check into a schedule dump —
 * the exact thing the VCAL security section forbids ("zwraca wyłącznie okna nakładające się na
 * podany termin (nie cały grafik)"). A day covers any real appointment, including one that
 * crosses midnight.
 */
export const PATIENT_VISIT_AVAILABILITY_PROBE_MAX_SPAN_MS = 24 * 60 * 60 * 1_000

/** IANA zone validation uses the runtime's installed ICU database. */
export const patientVisitTimeZoneSchema = z.string().trim().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}, 'Expected a valid IANA time zone')

const visitScheduleFields = {
  startsAt: patientVisitInstantSchema,
  endsAt: patientVisitInstantSchema.nullish(),
  timeZone: patientVisitTimeZoneSchema,
}

/**
 * Confirms that the wall-clock part submitted by the client exists in the named zone and
 * that the explicit offset selects the same instant. This rejects DST gaps while allowing
 * either explicit offset of an autumn fold.
 */
export function patientVisitInstantMatchesTimeZone(instant: string, timeZone: string): boolean {
  const wallClock = instant.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!wallClock) return false
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant))
    const byType = new Map(parts.map((part) => [part.type, part.value]))
    return (
      byType.get('year') === wallClock[1] &&
      byType.get('month') === wallClock[2] &&
      byType.get('day') === wallClock[3] &&
      byType.get('hour') === wallClock[4] &&
      byType.get('minute') === wallClock[5] &&
      byType.get('second') === (wallClock[6] ?? '00')
    )
  } catch {
    return false
  }
}

const serviceProductIdsSchema = z
  .array(z.string().uuid())
  .max(100)

export const patientVisitConflictOverrideSchema = z.object({
  acknowledgedSignatures: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100),
  reason: z.string().trim().min(1).max(2_000),
}).strict()

export const patientVisitAvailabilityCheckQuerySchema = z.object({
  teamMemberId: z.string().uuid(),
  startsAt: patientVisitInstantSchema,
  endsAt: patientVisitInstantSchema.optional(),
  resourceId: z.string().uuid().optional(),
  excludeVisitId: z.string().uuid().optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.endsAt) return
  const startsAt = Date.parse(value.startsAt)
  const endsAt = Date.parse(value.endsAt)
  if (endsAt <= startsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'The visit end must be later than its start',
    })
    return
  }
  if (endsAt - startsAt > PATIENT_VISIT_AVAILABILITY_PROBE_MAX_SPAN_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'The checked visit span cannot exceed 24 hours',
    })
  }
})

const PATIENT_VISIT_CALENDAR_MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1_000

export const patientVisitCalendarQuerySchema = z.object({
  from: patientVisitInstantSchema,
  to: patientVisitInstantSchema,
  teamMemberId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  status: z.enum(['planned', 'completed', 'cancelled', 'no_show']).optional(),
}).strict().superRefine((value, ctx) => {
  const from = Date.parse(value.from)
  const to = Date.parse(value.to)
  if (to <= from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'The calendar range end must be later than its start',
    })
    return
  }
  if (to - from > PATIENT_VISIT_CALENDAR_MAX_RANGE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'The calendar range cannot exceed 62 days',
    })
  }
})

export const patientVisitCreateSchema = z
  .object({
    ...visitScheduleFields,
    patientId: z.string().uuid(),
    teamMemberId: z.string().uuid(),
    resourceId: z.string().uuid().nullish(),
    description: clearableText(20_000).optional(),
    serviceProductIds: serviceProductIdsSchema.optional().default([]),
    clientRequestId: z.string().uuid(),
    conflictOverride: patientVisitConflictOverrideSchema.optional(),
  })
  .strict()

export const patientVisitUpdateSchema = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().min(1),
    teamMemberId: z.string().uuid().optional(),
    resourceId: z.string().uuid().nullish(),
    startsAt: patientVisitInstantSchema.optional(),
    endsAt: patientVisitInstantSchema.nullish(),
    timeZone: patientVisitTimeZoneSchema.optional(),
    description: clearableText(20_000).optional(),
    serviceProductIds: serviceProductIdsSchema.optional(),
    conflictOverride: patientVisitConflictOverrideSchema.optional(),
  })
  .strict()

export const patientVisitDeleteSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
}).strict()

const patientVisitActionBase = {
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
}

const patientVisitActionReasonSchema = z.string().trim().min(1).max(2_000)

function addPatientVisitTransitionIssues(
  value: { status: 'planned' | 'completed' | 'cancelled' | 'no_show'; reason?: string },
  ctx: z.RefinementCtx,
): void {
  const reasonRequired = value.status === 'planned' || value.status === 'cancelled' || value.status === 'no_show'
  if (reasonRequired && !value.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A reason is required for this visit status change',
      path: ['reason'],
    })
  }
  if (value.status === 'completed' && value.reason !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A completion does not accept a reason',
      path: ['reason'],
    })
  }
}

/** Commands are split by action so a caller cannot smuggle the target state. */
export const patientVisitConfirmActionSchema = z.object({
  ...patientVisitActionBase,
  sendPaymentLinkEmail: z.boolean().optional(),
}).strict()

export const patientVisitUnconfirmActionSchema = z.object(patientVisitActionBase).strict()

/** Backward-compatible name for existing internal consumers of the confirm shape. */
export const patientVisitConfirmationActionSchema = patientVisitConfirmActionSchema

export const patientVisitTransitionSchema = z
  .object({
    ...patientVisitActionBase,
    status: z.enum(['planned', 'completed', 'cancelled', 'no_show']),
    reason: patientVisitActionReasonSchema.optional(),
  })
  .strict()
  .superRefine(addPatientVisitTransitionIssues)

export const patientVisitSettleSchema = z.object({
  ...patientVisitActionBase,
  reason: patientVisitActionReasonSchema.optional(),
}).strict()

export const patientVisitUnsettleSchema = z.object({
  ...patientVisitActionBase,
  reason: patientVisitActionReasonSchema,
}).strict()

/** HTTP action bodies keep the record id in the path and reject all scope/actor keys. */
export const patientVisitConfirmationRequestSchema = z.discriminatedUnion('confirmed', [
  z.object({
    confirmed: z.literal(true),
    expectedUpdatedAt: z.string().min(1),
    sendPaymentLinkEmail: z.boolean().optional(),
  }).strict(),
  z.object({
    confirmed: z.literal(false),
    expectedUpdatedAt: z.string().min(1),
  }).strict(),
])

export const patientVisitPaymentLinkRequestSchema = z.object({
  expectedUpdatedAt: z.string().min(1),
}).strict()

export const patientVisitPaymentLinkEmailRequestSchema = z.object({
  expectedUpdatedAt: z.string().min(1),
}).strict()

export const patientVisitEnsurePaymentLinkActionSchema = z.object(patientVisitActionBase).strict()
export const patientVisitSendPaymentLinkEmailActionSchema = z.object(patientVisitActionBase).strict()

export const patientVisitStatusRequestSchema = z.object({
  status: z.enum(['planned', 'completed', 'cancelled', 'no_show']),
  reason: patientVisitActionReasonSchema.optional(),
  expectedUpdatedAt: z.string().min(1),
}).strict().superRefine(addPatientVisitTransitionIssues)

export const patientVisitSettlementRequestSchema = z.object({
  isSettled: z.boolean(),
  reason: patientVisitActionReasonSchema.optional(),
  expectedUpdatedAt: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if (!value.isSettled && !value.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A reason is required to remove manual settlement',
      path: ['reason'],
    })
  }
})

const patientVisitIdsQuerySchema = z.string().superRefine((value, ctx) => {
  const ids = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (ids.length === 0 || ids.length > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'ids must contain between 1 and 100 UUIDs',
    })
    return
  }
  const uuid = z.string().uuid()
  if (ids.some((id) => !uuid.safeParse(id).success)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ids must contain only UUIDs' })
  }
})

const patientVisitListQueryFields = {
  id: z.string().uuid().optional(),
  ids: patientVisitIdsQuerySchema.optional(),
  patientId: z.string().uuid().optional(),
  teamMemberId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
  status: z.enum(['planned', 'completed', 'cancelled', 'no_show']).optional(),
  isSettled: z.enum(['true', 'false']).optional(),
  from: patientVisitInstantSchema.optional(),
  to: patientVisitInstantSchema.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  sortField: z.enum(['id', 'starts_at', 'startsAt', 'ends_at', 'endsAt', 'status', 'is_settled', 'isSettled', 'updated_at', 'updatedAt']).optional().default('starts_at'),
  sortDir: z.enum(['asc', 'desc']).optional().default('asc'),
}

/** Unrefined twin used by the installed OpenAPI CRUD helper, which extends object schemas. */
export const patientVisitListOpenApiQuerySchema = z.object(patientVisitListQueryFields).strict()

export const patientVisitListQuerySchema = z.object(patientVisitListQueryFields).strict().refine((value) => !value.from || !value.to || Date.parse(value.to) > Date.parse(value.from), {
  message: 'The range end must be later than its start',
  path: ['to'],
})

export type PatientCreateInput = z.infer<typeof patientCreateSchema>
export type PatientUpdateInput = z.infer<typeof patientUpdateSchema>
export type PatientAddressCreateInput = z.infer<typeof patientAddressCreateSchema>
export type PatientAddressUpdateInput = z.infer<typeof patientAddressUpdateSchema>
export type PatientContactCreateInput = z.infer<typeof patientContactCreateSchema>
export type PatientContactUpdateInput = z.infer<typeof patientContactUpdateSchema>
export type PatientDiagnosisCreateInput = z.infer<typeof patientDiagnosisCreateSchema>
export type PatientDiagnosisCorrectInput = z.infer<typeof patientDiagnosisCorrectSchema>
export type PatientVisitCreateInput = z.infer<typeof patientVisitCreateSchema>
export type PatientVisitUpdateInput = z.infer<typeof patientVisitUpdateSchema>
export type PatientVisitTransitionInput = z.infer<typeof patientVisitTransitionSchema>
