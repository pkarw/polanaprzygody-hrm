import { z, type ZodTypeAny } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  createCrudOpenApiFactory,
  createPagedListResponseSchema as createSharedPagedListResponseSchema,
  type CrudOpenApiOptions,
} from '@open-mercato/shared/lib/openapi/crud'

export const patientTag = 'Patients'

export const patientErrorSchema = z
  .object({
    error: z.string(),
  })
  .passthrough()

export const patientOkSchema = z.object({ ok: z.literal(true) })

export const patientCreatedSchema = z.object({
  id: z.string().uuid(),
  patientNumber: z.string().optional(),
  updatedAt: z.string().nullable().optional(),
})

export const patientVersionedResultSchema = z.object({
  ok: z.literal(true),
  id: z.string().uuid(),
  updatedAt: z.string().nullable(),
})

/**
 * A resolved reference as the API returns it.
 *
 * `name` is a display name and `isAvailable` says whether the referenced record is still
 * active. The UI renders the name with an "unavailable" marker when it is false, which is
 * how historical references stay readable without being re-selectable. The raw uuid is
 * present because the form needs it as a form value — it is never rendered.
 */
export const patientReferenceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  isAvailable: z.boolean(),
})

export const patientNextVisitSchema = z.object({
  startsAt: z.string(),
  timeZone: z.string(),
  resourceNameSnapshot: z.string().nullable(),
  confirmedAt: z.string().nullable(),
})

/**
 * The patient list row.
 *
 * Names and contact channels ARE part of the list projection — the grid renders them, so
 * the per-row decrypt is a cost the surface actually needs. `description` is deliberately
 * absent: no list renders it, and it is this module's longest free-text field, so
 * projecting it would decrypt the most sensitive column on every page for nothing.
 * Sorting never uses an encrypted column; `patientNumber`, `status` and `createdAt` are
 * the sortable ones.
 */
export const patientListItemSchema = z
  .object({
    id: z.string().uuid(),
    patientNumber: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    owner: patientReferenceSchema.nullable(),
    status: z.enum(['active', 'archived']),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    // Omitted entirely when the caller lacks `patient.visits.view`.
    nextVisit: patientNextVisitSchema.nullable().optional(),
  })
  .passthrough()

export const patientDetailSchema = patientListItemSchema.extend({
  birthDate: z.string().nullable(),
  description: z.string().nullable(),
  ownerTeamMemberId: z.string().uuid().nullable(),
  archivedAt: z.string().nullable(),
})

export const patientAddressItemSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  name: z.string().nullable(),
  purpose: z.string().nullable(),
  companyName: z.string().nullable(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  buildingNumber: z.string().nullable(),
  flatNumber: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  isPrimary: z.boolean(),
  updatedAt: z.string().nullable(),
})

export const patientContactItemSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  person: patientReferenceSchema.nullable(),
  customerEntityId: z.string().uuid(),
  isGuardian: z.boolean(),
  isContact: z.boolean(),
  isPayer: z.boolean(),
  isPrimaryContact: z.boolean(),
  relationshipLabel: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

/**
 * A diagnosis as the API returns it.
 *
 * Only ever returned from a request that names a `patientId`, and only to a caller with
 * the clinical feature. The general patient list never carries any of this.
 */
export const patientDiagnosisItemSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  diagnosedOn: z.string(),
  code: z.string().nullable(),
  codeSystem: z.string().nullable(),
  codeVersion: z.string().nullable(),
  author: patientReferenceSchema.nullable(),
  authorUserId: z.string().uuid(),
  supersedesId: z.string().uuid().nullable(),
  supersededById: z.string().uuid().nullable(),
  status: z.enum(['active', 'superseded', 'voided']),
  voidReason: z.string().nullable(),
  voidedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

export const patientDocumentLinkItemSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  documentId: z.string().uuid(),
  state: z.enum(['pending_create', 'linked', 'abandoned']),
  /**
   * The document's own title, present only when the caller passes the documents module's
   * access check. A caller without it sees `null` rather than a redacted placeholder — the
   * spec forbids leaking a title to someone the document ACL would refuse.
   */
  title: z.string().nullable(),
  /** True when the same document is pinned to more than one patient, so the UI can warn. */
  isSharedWithOtherPatients: z.boolean(),
  updatedAt: z.string().nullable(),
})

export const patientAttachmentLinkItemSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  diagnosisId: z.string().uuid().nullable(),
  attachmentId: z.string().uuid(),
  fileName: z.string().nullable(),
  state: z.enum(['active', 'detached']),
  updatedAt: z.string().nullable(),
})

export const patientVisitServiceItemSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  title: z.string(),
  sku: z.string().nullable(),
  position: z.number().int().min(0),
})

export const patientVisitListItemSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  patientName: z.string().nullable(),
  teamMemberId: z.string().uuid(),
  teamMemberName: z.string(),
  resourceId: z.string().uuid().nullable(),
  resourceName: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  timeZone: z.string(),
  status: z.enum(['planned', 'completed', 'cancelled', 'no_show']),
  confirmedAt: z.string().nullable(),
  isConfirmed: z.boolean(),
  confirmationApplicable: z.boolean(),
  isSettled: z.boolean(),
  settledAt: z.string().nullable(),
  services: z.array(patientVisitServiceItemSchema),
  updatedAt: z.string(),
  /** Present only for an explicit `?id=` detail lookup. */
  description: z.string().nullable().optional(),
})

export const patientVisitDetailSchema = patientVisitListItemSchema.safeExtend({
  description: z.string().nullable(),
})

export const patientVisitCreatedSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['planned', 'completed', 'cancelled', 'no_show']),
  confirmedAt: z.string().nullable(),
  isSettled: z.boolean(),
  updatedAt: z.string(),
})

export const patientVisitVersionedResultSchema = z.object({
  ok: z.literal(true),
  id: z.string().uuid(),
  updatedAt: z.string(),
})

export const patientVisitLifecycleResultSchema = patientVisitVersionedResultSchema.extend({
  status: z.enum(['planned', 'completed', 'cancelled', 'no_show']),
  confirmedAt: z.string().nullable(),
  isConfirmed: z.boolean(),
  confirmationApplicable: z.boolean(),
  isSettled: z.boolean(),
  settledAt: z.string().nullable(),
})

export const patientVisitDeletedResultSchema = patientVisitVersionedResultSchema.extend({
  deleted: z.literal(true),
})

export function createPatientPagedListResponseSchema(itemSchema: ZodTypeAny) {
  return createSharedPagedListResponseSchema(itemSchema, { paginationMetaOptional: true })
}

const buildPatientCrudOpenApi = createCrudOpenApiFactory({
  defaultTag: patientTag,
  defaultCreateResponseSchema: patientCreatedSchema,
  defaultOkResponseSchema: patientOkSchema,
  makeListDescription: ({ pluralLower }) =>
    `Returns a paginated collection of ${pluralLower} in the caller's tenant and selected organization.`,
})

export function createPatientCrudOpenApi(options: CrudOpenApiOptions): OpenApiRouteDoc {
  return buildPatientCrudOpenApi(options)
}

/** The error rows every write route in this module can return. */
export const patientWriteErrors = [
  { status: 400, description: 'Invalid payload, missing version token, or a server-owned field was supplied', schema: patientErrorSchema },
  { status: 401, description: 'Authentication required', schema: patientErrorSchema },
  { status: 403, description: 'The required feature is not granted, or the payload targets another tenant', schema: patientErrorSchema },
  { status: 404, description: 'The record is not visible in this scope', schema: patientErrorSchema },
  { status: 409, description: 'Stale version, or the write would break an invariant', schema: patientErrorSchema },
  { status: 422, description: 'A referenced record is inactive, or the requested lifecycle transition is not yet allowed', schema: patientErrorSchema },
  { status: 503, description: 'Encryption, storage or an owner-authorization contract is unavailable', schema: patientErrorSchema },
] as const
