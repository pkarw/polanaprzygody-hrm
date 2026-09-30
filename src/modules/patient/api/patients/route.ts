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
  findEntityIdsBySearchTokens,
  type SearchTokenDatabase,
} from '@open-mercato/shared/lib/search/tokenLookup'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomFieldDef } from '@open-mercato/core/modules/entities/data/entities'
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
import { buildDeleteCommandInput } from '../../lib/deleteInput'
import { PATIENT_PROTECTED_KEYS } from '../../lib/routeSupport'
import { enrichPatientNextVisits } from '../../lib/visitApi'
import {
  createPatientCrudOpenApi,
  createPatientPagedListResponseSchema,
  patientCreatedSchema,
  patientDetailSchema,
  patientOkSchema,
} from '../openapi'

const ENTITY_ID = 'patient:patient' as const

/**
 * The encrypted columns the single search box reaches through the token index.
 *
 * Deliberately narrower than the encryption map: `description` is a free-text clinical
 * note and `create_request_payload` is an idempotency digest, and neither is something an
 * operator means to search a register by. Adding a field here makes its content
 * discoverable by anyone holding `patient.patients.view`.
 */
const PATIENT_SEARCH_TOKEN_FIELDS = ['first_name', 'last_name', 'email', 'phone'] as const

/**
 * List query.
 *
 * `search` is the list's one box and spans both kinds of column: a substring of the
 * plaintext `patient_number`, or a name / email / phone resolved through the hashed token
 * index, because those columns hold ciphertext and an `ilike` against them matches
 * nothing. `resolvePatientSearchIds` owns that split.
 *
 * The per-field parameters below remain for API callers that know which column they mean.
 * `patientNumber` is matched exactly; `firstName` / `lastName` / `email` / `phone` go
 * through the query engine's like-rewrite, which resolves them against the same token
 * index and warns rather than silently matching nothing when search is switched off.
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
    /** The list's one search box: patient number, name, email or phone. */
    search: z.string().optional(),
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
 * Custom-field keys for the CURRENT request.
 *
 * `cfSel.keys` only knows what `ce.ts` declares in code, and this module declares no
 * built-in fields at all — every patient custom field is defined at runtime through
 * "Manage fields". Projecting `cfSel.keys` alone therefore asks the query engine for
 * nothing, and the edit form renders every custom field empty no matter what is stored.
 *
 * So the keys are discovered per request from the definitions visible in the caller's
 * scope, and published on the per-request `CrudCtx` the factory creates. The WeakMap is
 * keyed by that context, so one request never sees another's projection and the entry is
 * collected with it.
 */
const requestCustomFieldKeys = new WeakMap<CrudCtx, string[]>()

function customFieldKeysFor(ctx: CrudCtx): string[] {
  return requestCustomFieldKeys.get(ctx) ?? cfSel.keys
}

function definitionPriority(def: CustomFieldDef): number {
  const config = def.configJson
  if (!config || typeof config !== 'object') return 0
  const priority = (config as Record<string, unknown>).priority
  return typeof priority === 'number' ? priority : 0
}

/**
 * The organizations this request may read, or `null` for "not restricted".
 *
 * A definition may be tenant-wide (`organization_id is null`) or scoped to one
 * organization, so both have to be admissible — but only the ones this caller is actually
 * scoped to, which is why the selected organization is the fallback rather than a wildcard.
 */
function resolveScopedOrganizationIds(ctx: CrudCtx): string[] | null {
  if (ctx.organizationIds === null) return null
  const declared = (ctx.organizationIds ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  if (declared.length > 0) return Array.from(new Set(declared))
  const selected = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  return selected ? [selected] : []
}

async function discoverCustomFieldKeys(ctx: CrudCtx): Promise<string[]> {
  const em = ctx.container.resolve<EntityManager>('em')
  const tenantId = ctx.auth?.tenantId ?? null
  const scopedOrgIds = resolveScopedOrganizationIds(ctx)

  const defs = await em.find(CustomFieldDef, {
    entityId: ENTITY_ID,
    $and: [
      ...(scopedOrgIds === null
        ? []
        : scopedOrgIds.length > 0
          ? [{ $or: [{ organizationId: { $in: scopedOrgIds } }, { organizationId: null }] }]
          : [{ organizationId: null }]),
      { $or: [{ tenantId }, { tenantId: null }] },
    ],
  })

  // A tenant- or organization-specific definition overrides the global one for the same key.
  const byKey = new Map<string, CustomFieldDef>()
  const specificity = (def: CustomFieldDef) => (def.tenantId ? 2 : 0) + (def.organizationId ? 1 : 0)
  for (const def of defs) {
    const existing = byKey.get(def.key)
    if (!existing || specificity(def) > specificity(existing)) byKey.set(def.key, def)
  }

  const tombstonedKeys = new Set(defs.filter((def) => !!def.deletedAt).map((def) => def.key))
  const keysFromDefs = Array.from(byKey.values())
    .filter((def) => def.isActive !== false && !def.deletedAt && !tombstonedKeys.has(def.key))
    .sort((left, right) => definitionPriority(left) - definitionPriority(right))
    .map((def) => def.key)

  return Array.from(new Set([...cfSel.keys, ...keysFromDefs]))
}

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
/**
 * Stands in for "no record can satisfy this filter".
 *
 * A search that matched nothing must produce an impossible predicate rather than no
 * predicate at all: dropping the filter would answer a failed search with the entire
 * register, which for a patient list is the worst possible failure mode.
 */
const NO_MATCH_ID = '00000000-0000-4000-8000-000000000000'

/** Bounds one search, so a one-letter term cannot drag the whole register through memory. */
const SEARCH_ID_LIMIT = 500

/** How many recent records the decrypt-in-memory fallback below is allowed to examine. */
const SEARCH_FALLBACK_SCAN_LIMIT = 200

/**
 * Resolves the list's single search term to a set of record ids.
 *
 * The term has to reach two kinds of column, and they cannot be filtered the same way:
 *
 * - `patient_number` is plaintext, so a substring match is a real SQL `ilike`. It has to
 *   run as SQL and not through the query engine's filter rewrite: with
 *   `OM_SEARCH_USE_ILIKE_FOR_NON_ENCRYPTED_FIELDS` at its default the engine routes even a
 *   plaintext `$ilike` to the token index, which is not what "starts with P-2" means.
 * - `first_name`, `last_name`, `email`, `phone` and `description` are covered by this
 *   module's encryption map, so the stored value is ciphertext and `ilike '%kow%'` matches
 *   nothing. The token index holds hashes of the plaintext, which is what keeps them
 *   findable — `findEntityIdsBySearchTokens` is the supported way in.
 *
 * `matched: false` from the token lookup means the index was NOT consulted (search
 * disabled, term produced no tokens, or the entity has no tokens yet). That is not "no
 * name matched", so it contributes nothing rather than an empty result — the number half
 * still answers.
 */
async function resolvePatientSearchIds(
  term: string,
  scope: { em: EntityManager; tenantId: string | null; organizationId: string | null },
): Promise<string[]> {
  const ids = new Set<string>()

  const numberRows = await scope.em.find(
    Patient,
    {
      patientNumber: { $ilike: `%${term}%` },
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
      ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      deletedAt: null,
    } as never,
    { fields: ['id'], limit: SEARCH_ID_LIMIT },
  )
  for (const row of numberRows) ids.add(String(row.id))

  const tokenMatch = await findEntityIdsBySearchTokens({
    db: scope.em.getKysely<SearchTokenDatabase>(),
    entityType: ENTITY_ID,
    query: term,
    fields: PATIENT_SEARCH_TOKEN_FIELDS,
    scope: { tenantId: scope.tenantId, organizationId: scope.organizationId },
  })
  if (tokenMatch.matched) {
    for (const id of tokenMatch.ids.slice(0, SEARCH_ID_LIMIT)) ids.add(id)
  }

  // Safety net for a record the token index has not caught up with.
  //
  // Tokens are written by the query index AFTER the write commits, so between creating a
  // patient and that pipeline completing, the record exists and is invisible to a search
  // by name — the one moment an operator is most likely to search for it. Worse, a
  // deployment whose indexing is not running at all would leave the whole register
  // unsearchable by name with no error anywhere.
  //
  // So when the index produced nothing for this term, the most recent page of records is
  // decrypted and matched in memory. It runs ONLY on that miss, it is capped, and it is
  // ordered by recency because the rows the index is missing are by definition the new
  // ones. Past the cap the fallback is deliberately partial — it is a bridge over index
  // lag, not a replacement for the index.
  if (ids.size === 0) {
    const needle = term.toLocaleLowerCase()
    const recent = await findWithDecryption(
      scope.em,
      Patient,
      {
        ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
        ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
        deletedAt: null,
      } as never,
      { orderBy: { createdAt: 'desc' }, limit: SEARCH_FALLBACK_SCAN_LIMIT },
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )
    for (const row of recent) {
      const haystack = [row.firstName, row.lastName, row.email, row.phone]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' ')
        .toLocaleLowerCase()
      if (haystack.includes(needle)) ids.add(String(row.id))
    }
  }

  return Array.from(ids)
}

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
  nextVisit?: {
    startsAt: string
    timeZone: string
    resourceNameSnapshot: string | null
    confirmedAt: string | null
  } | null
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
    fields: (query: Query, ctx: CrudCtx) => [
      ...baseListFields,
      ...(isSingleRecordRequest(query) ? [descriptionField, birth_date, archived_at] : []),
      ...customFieldKeysFor(ctx).map((key) => `cf:${key}`),
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

      // The list's single search box. One term has to reach both a plaintext column and
      // five encrypted ones, and those need opposite treatments, so the two halves are
      // resolved to id sets here and unioned — see `resolvePatientSearchIds`.
      if (typeof q.search === 'string' && q.search.trim().length > 0) {
        const matchedIds = await resolvePatientSearchIds(q.search.trim(), {
          em: ctx.container.resolve<EntityManager>('em'),
          tenantId: ctx.auth?.tenantId ?? null,
          organizationId: ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null,
        })
        // An empty set is a real "no match", not an absent filter: without the
        // impossible predicate the search box would silently return the whole register.
        const narrowed = matchedIds.length > 0 ? matchedIds : [NO_MATCH_ID]
        const existing = F.id
        if (existing && typeof existing === 'object' && '$in' in existing) {
          const previous = (existing as { $in: string[] }).$in
          const allowed = new Set(narrowed)
          F.id = { $in: previous.filter((value) => allowed.has(value)) }
        } else if (typeof existing === 'string') {
          F.id = narrowed.includes(existing) ? existing : NO_MATCH_ID
        } else {
          F.id = { $in: narrowed }
        }
      }
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
     * Publishes the request's custom-field keys before `fields` is consulted, so the
     * projection includes fields an operator defined at runtime.
     *
     * Failing soft is deliberate: a discovery error must degrade to the code-declared
     * selectors and still return the record, not turn a readable patient into an error.
     */
    beforeList: async (_query: Query, ctx: CrudCtx) => {
      try {
        requestCustomFieldKeys.set(ctx, await discoverCustomFieldKeys(ctx))
      } catch {
        // Fall back to the code-declared selectors.
      }
    },
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
      await enrichPatientNextVisits(items, ctx)
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
      if (!tenantId || !organizationId) return

      const ownerIds = items
        .map((item) => item.ownerTeamMemberId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)

      if (ownerIds.length > 0) {
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
      // DELETE is handed `{ body, query }` rather than the body; see the helper.
      mapInput: ({ raw, ctx }) => buildDeleteCommandInput(raw, ctx.request),
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
