import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { Where, WhereValue } from '@open-mercato/shared/lib/query/types'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  buildCustomFieldFiltersFromQuery,
  buildCustomFieldSelectorsForEntity,
  extractAllCustomFieldEntries,
} from '@open-mercato/shared/lib/crud/custom-fields'
import type { CustomFieldSet } from '@open-mercato/shared/modules/entities'
import {
  archived_at,
  birth_date,
  created_at,
  description as descriptionField,
  email as emailField,
  first_name,
  id as idField,
  last_name,
  organization_id,
  owner_team_member_id,
  patient_number,
  phone as phoneField,
  status as statusField,
  tenant_id,
  updated_at,
} from '@/.mercato/generated/entities/patient'
import ceEntities from '../../ce'
import { Patient } from '../../data/entities'
import '../../commands/patients'
import type { PatientReferenceService, ResolvedReference } from '../../lib/patientReferenceService'
import { toIsoTimestamp } from '../../lib/commandSupport'
import { PATIENT_PROTECTED_KEYS } from '../../lib/routeSupport'
import {
  createPatientCrudOpenApi,
  createPatientPagedListResponseSchema,
  patientCreatedSchema,
  patientDetailSchema,
  patientOkSchema,
} from '../openapi'

const ENTITY_ID = 'patient:patient' as const

/**
 * List query.
 *
 * Searching is exact, never a substring, and this is a consequence of the data model
 * rather than a limitation of the UI: names and contact channels are encrypted, so
 * `last_name ilike '%kow%'` would compare a plaintext pattern against ciphertext and match
 * nothing. `patientNumber` is the one plaintext handle and is matched exactly;
 * `firstName` / `lastName` / `email` / `phone` are routed through the query engine's
 * like-rewrite, which resolves them against the hashed token index when search is active
 * and warns rather than silently matching nothing when it is not.
 *
 * `format` is absent on purpose — there is no CSV export. See `../../encryption.ts`.
 */
const querySchema = z
  .object({
    id: z.string().uuid().optional(),
    ids: z.string().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional().default('created_at'),
    sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
    status: z.enum(['active', 'archived']).optional(),
    patientNumber: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    ownerTeamMemberId: z.string().uuid().optional(),
    withDeleted: z.coerce.boolean().optional().default(false),
  })
  .passthrough()

type Query = z.infer<typeof querySchema>

/**
 * Write bodies are accepted as pass-through objects and validated by the commands' own
 * schemas, which own the domain rules. What this route adds on top is the rejection of
 * server-owned keys, below — the factory's own parse would strip them silently and return
 * 200 for a request that tried to set `status`.
 */
const rawBodySchema = z.object({}).passthrough()

const baseFieldSets: CustomFieldSet[] = []
const patientCe = Array.isArray(ceEntities) ? ceEntities.find((entity) => entity?.id === ENTITY_ID) : undefined
if (patientCe?.fields?.length) {
  baseFieldSets.push({ entity: patientCe.id, fields: patientCe.fields, source: 'patient' })
}
const cfSel = buildCustomFieldSelectorsForEntity(ENTITY_ID, baseFieldSets)

/**
 * `updated_at` is part of every projection because it IS the optimistic-lock token:
 * `CrudForm` derives the expected-version header from `initialValues.updatedAt`, and a row
 * action derives it from the row. Dropping it silently disables optimistic locking.
 */
const baseListFields = [
  idField,
  patient_number,
  first_name,
  last_name,
  emailField,
  phoneField,
  owner_team_member_id,
  statusField,
  tenant_id,
  organization_id,
  created_at,
  updated_at,
]

/**
 * Columns projected only for a single-record request.
 *
 * `description` is encrypted and is the module's longest free-text field, so a grid page would
 * pay the most expensive per-row decrypt for a column nothing on the page renders.
 * `birth_date` and `archived_at` are likewise only rendered on the card.
 *
 * A single-record request is exactly how the detail form loads one patient — and every field the
 * edit form binds MUST be in this list, or it silently loads blank and a save then clears it.
 */
function isSingleRecordRequest(query: Pick<Query, 'id' | 'ids'>): boolean {
  if (typeof query.id === 'string' && query.id.length > 0) return true
  return typeof query.ids === 'string' && query.ids.trim().length > 0
}

/**
 * Sortable columns.
 *
 * Every encrypted column is absent, and that absence is not enforcement — the factory
 * falls through to the raw field name for an unmapped sort field, so `?sortField=last_name`
 * still reaches the engine, which then routes it to a decrypt-then-sort-in-memory path
 * that is row-capped and therefore silently partial past the cap. Keeping the map to
 * plaintext columns is what the list UI offers; the spec's "sort by number, date, status"
 * is the contract.
 */
const sortFieldMap: Record<string, string> = {
  id: idField,
  patient_number,
  patientNumber: patient_number,
  status: statusField,
  created_at,
  createdAt: created_at,
  updated_at,
  updatedAt: updated_at,
}

type PatientRow = {
  id: string
  patient_number: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  description?: string | null
  birth_date?: string | null
  owner_team_member_id: string | null
  status: 'active' | 'archived'
  archived_at?: Date | string | null
  tenant_id: string | null
  organization_id: string | null
  created_at: Date | string | null
  updated_at: Date | string | null
} & Record<`cf:${string}` | `cf_${string}`, unknown>

type PatientItem = {
  id: string
  patientNumber: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  email: string | null
  phone: string | null
  description?: string | null
  birthDate?: string | null
  ownerTeamMemberId: string | null
  owner: { id: string; name: string; isAvailable: boolean } | null
  status: 'active' | 'archived'
  archivedAt?: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** `null` rather than an empty string when both halves are missing, so the UI can branch. */
function composeDisplayName(firstName: string | null, lastName: string | null): string | null {
  const parts = [firstName, lastName].filter((part): part is string => Boolean(part && part.length > 0))
  return parts.length > 0 ? parts.join(' ') : null
}

function rejectServerOwnedKeys(parsed: Record<string, unknown>): Record<string, unknown> {
  const present = PATIENT_PROTECTED_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(parsed, key),
  )
  if (present.length > 0) {
    throw new CrudHttpError(400, {
      error: 'These fields are set by the server and cannot be supplied',
      fields: present,
    })
  }
  return parsed
}

export const { metadata, GET, POST, PUT, DELETE } = makeCrudRoute({
  metadata: {
    GET: { requireAuth: true, requireFeatures: ['patient.patients.view'] },
    POST: { requireAuth: true, requireFeatures: ['patient.patients.manage'] },
    PUT: { requireAuth: true, requireFeatures: ['patient.patients.manage'] },
    DELETE: { requireAuth: true, requireFeatures: ['patient.patients.manage'] },
  },
  orm: {
    entity: Patient,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  events: { module: 'patient', entity: 'patient', persistent: true },
  indexer: { entityType: ENTITY_ID },
  list: {
    schema: querySchema,
    entityId: ENTITY_ID,
    fields: (query: Query) => [
      ...baseListFields,
      ...(isSingleRecordRequest(query) ? [descriptionField, birth_date, archived_at] : []),
      ...cfSel.keys.map((key) => `cf:${key}`),
    ],
    sortFieldMap,
    buildFilters: async (q: Query, ctx): Promise<Where<PatientRow>> => {
      const filters: Where<PatientRow> = {}
      const F = filters as Record<string, WhereValue>
      if (q.ids) {
        const ids = q.ids
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
        if (ids.length > 0) F.id = { $in: ids }
      }
      if (q.id) F.id = q.id
      if (q.status) F.status = q.status
      // Plaintext column, so an exact equality is a real index lookup.
      if (q.patientNumber) F.patient_number = q.patientNumber
      // Encrypted columns. A plain `$ilike` is deliberate: the query engine intercepts it
      // and rewrites it into a `search_tokens` lookup over hashes of the decrypted value.
      // Hand-rolling an id narrowing here would duplicate that and would have to re-apply
      // the tenant/organization scope the engine's token path already applies.
      if (q.firstName) F.first_name = { $ilike: q.firstName }
      if (q.lastName) F.last_name = { $ilike: q.lastName }
      if (q.email) F.email = { $ilike: q.email }
      if (q.phone) F.phone = { $ilike: q.phone }
      if (q.ownerTeamMemberId) F.owner_team_member_id = q.ownerTeamMemberId

      const cfFilterMap = await buildCustomFieldFiltersFromQuery({
        entityId: ENTITY_ID,
        query: q as Record<string, unknown>,
        em: ctx.container.resolve<EntityManager>('em'),
        tenantId: ctx.auth!.tenantId,
      })
      Object.assign(F, cfFilterMap)
      return filters
    },
    transformItem: (item: PatientRow): PatientItem => ({
      id: String(item.id),
      patientNumber: String(item.patient_number),
      firstName: item.first_name ?? null,
      lastName: item.last_name ?? null,
      displayName: composeDisplayName(item.first_name ?? null, item.last_name ?? null),
      email: item.email ?? null,
      phone: item.phone ?? null,
      ...(item.description !== undefined ? { description: item.description ?? null } : {}),
      ...(item.birth_date !== undefined ? { birthDate: item.birth_date ?? null } : {}),
      ownerTeamMemberId: item.owner_team_member_id ?? null,
      // Filled in by `afterList` in ONE batched lookup for the whole page.
      owner: null,
      status: item.status,
      ...(item.archived_at !== undefined ? { archivedAt: toIsoTimestamp(item.archived_at) } : {}),
      createdAt: toIsoTimestamp(item.created_at),
      updatedAt: toIsoTimestamp(item.updated_at),
      ...extractAllCustomFieldEntries(item),
    }),
    allowCsv: false,
  },
  hooks: {
    /**
     * Resolves the lead-carer display names for the whole page in a single query.
     *
     * This is why `transformItem` leaves `owner` null: it runs per row and would issue one
     * staff lookup per patient. Batching here keeps the list at one extra query per page,
     * which is the discipline the spec sets out for the equivalent VIS column.
     */
    afterList: async (res: { items?: PatientItem[] }, ctx: CrudCtx) => {
      const items = Array.isArray(res?.items) ? res.items : []
      if (items.length === 0) return
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
      if (!tenantId || !organizationId) return

      const ownerIds = items
        .map((item) => item.ownerTeamMemberId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
      if (ownerIds.length === 0) return

      const references = ctx.container.resolve<PatientReferenceService>('patientReferenceService')
      const resolved: Map<string, ResolvedReference> = await references.resolveTeamMembers(ownerIds, {
        tenantId,
        organizationId,
      })
      for (const item of items) {
        if (!item.ownerTeamMemberId) continue
        const reference = resolved.get(item.ownerTeamMemberId)
        // A reference that resolves to nothing is left null rather than rendered as a raw
        // uuid: the spec forbids showing identifiers in the UI, and "unavailable" is the
        // honest label for a staff member this scope can no longer see.
        item.owner = reference
          ? { id: reference.id, name: reference.displayName, isAvailable: reference.isAvailable }
          : null
      }
    },
  },
  actions: {
    create: {
      commandId: 'patient.patients.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        id: String((result as { id: string }).id),
        patientNumber: String((result as { patientNumber: string }).patientNumber),
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
      status: 201,
    },
    update: {
      commandId: 'patient.patients.update',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as { id: string }).id),
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
    },
    delete: {
      commandId: 'patient.patients.delete',
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as { id: string }).id),
        deleted: true as const,
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
    },
  },
})

const patientDeleteBodySchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

export const openApi: OpenApiRouteDoc = createPatientCrudOpenApi({
  resourceName: 'Patient',
  pluralName: 'Patients',
  querySchema,
  listResponseSchema: createPatientPagedListResponseSchema(patientDetailSchema),
  create: {
    schema: rawBodySchema,
    description:
      'Creates a patient together with its first address in one transaction. Requires `clientRequestId`; repeating it with the same content returns the original record, and with different content returns 409. Additional `cf_` keys set custom fields.',
    responseSchema: patientCreatedSchema,
  },
  update: {
    schema: rawBodySchema,
    description:
      'Updates the record\'s own fields. Requires `expectedUpdatedAt`. Addresses, contacts and the archive transition each have their own endpoint; supplying a server-owned field such as `status` returns 400 rather than being ignored.',
    responseSchema: patientOkSchema,
  },
  del: {
    schema: patientDeleteBodySchema,
    description:
      'Soft-deletes a record created in error. Refused with 409 when the record has diagnoses, document links or file links — archive it instead.',
    responseSchema: patientOkSchema,
  },
})
