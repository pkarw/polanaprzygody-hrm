import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { Where, WhereValue } from '@open-mercato/shared/lib/query/types'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  author_user_id,
  code as codeField,
  code_system,
  code_version,
  description as descriptionField,
  diagnosed_on,
  id as idField,
  organization_id,
  patient_id,
  status as statusField,
  supersedes_id,
  tenant_id,
  title as titleField,
  updated_at,
  void_reason,
  voided_at,
} from '@/.mercato/generated/entities/patient_diagnosis'
import { PatientDiagnosis } from '../../data/entities'
import { toIsoTimestamp } from '../../lib/commandSupport'
import type { PatientReferenceService, ResolvedReference } from '../../lib/patientReferenceService'
import { PATIENT_PROTECTED_KEYS } from '../../lib/routeSupport'
import {
  createPatientCrudOpenApi,
  createPatientPagedListResponseSchema,
  patientCreatedSchema,
  patientDiagnosisItemSchema,
} from '../openapi'
import '../../commands/diagnoses'

const ENTITY_ID = 'patient:patient_diagnosis' as const

/**
 * Diagnoses are always read for ONE patient.
 *
 * `patientId` is required, not optional. An organization-wide diagnosis list would be a
 * clinical register readable in one page, and the spec states that a general patient read
 * never carries clinical content and that diagnosis reads always name the patient.
 */
const querySchema = z
  .object({
    patientId: z.string().uuid(),
    id: z.string().uuid().optional(),
    ids: z.string().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional().default('diagnosed_on'),
    sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
    status: z.enum(['active', 'superseded', 'voided']).optional(),
  })
  .passthrough()

type Query = z.infer<typeof querySchema>

const rawBodySchema = z.object({}).passthrough()

/**
 * `diagnosed_on` is the one sortable content column, and the only reason it can be is that it
 * is deliberately left unencrypted — see `../../encryption.ts`. Title and description are
 * ciphertext and are absent here.
 */
const sortFieldMap: Record<string, string> = {
  id: idField,
  diagnosed_on,
  diagnosedOn: diagnosed_on,
  status: statusField,
  updated_at,
  updatedAt: updated_at,
}

type DiagnosisRow = {
  id: string
  patient_id: string
  title: string
  description: string
  diagnosed_on: string | Date
  code: string | null
  code_system: string | null
  code_version: string | null
  author_user_id: string
  supersedes_id: string | null
  status: 'active' | 'superseded' | 'voided'
  void_reason: string | null
  voided_at: Date | string | null
  updated_at: Date | string | null
}

type DiagnosisItem = {
  id: string
  patientId: string
  title: string
  description: string
  diagnosedOn: string
  code: string | null
  codeSystem: string | null
  codeVersion: string | null
  authorUserId: string
  author: { id: string; name: string; isAvailable: boolean } | null
  supersedesId: string | null
  supersededById: string | null
  status: 'active' | 'superseded' | 'voided'
  voidReason: string | null
  voidedAt: string | null
  updatedAt: string | null
}

/** A `date` column arrives as a Date or a string depending on the driver path. */
function toIsoDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
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

export const { metadata, GET, POST } = makeCrudRoute({
  metadata: {
    // The clinical features, not the records ones. Reception can open the patient card and
    // never reach this route.
    GET: { requireAuth: true, requireFeatures: ['patient.clinical.view'] },
    POST: { requireAuth: true, requireFeatures: ['patient.clinical.manage'] },
  },
  orm: {
    entity: PatientDiagnosis,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  events: { module: 'patient', entity: 'diagnosis', persistent: true },
  indexer: { entityType: ENTITY_ID },
  list: {
    schema: querySchema,
    entityId: ENTITY_ID,
    fields: () => [
      idField,
      patient_id,
      titleField,
      descriptionField,
      diagnosed_on,
      codeField,
      code_system,
      code_version,
      author_user_id,
      supersedes_id,
      statusField,
      void_reason,
      voided_at,
      tenant_id,
      organization_id,
      updated_at,
    ],
    sortFieldMap,
    buildFilters: async (q: Query): Promise<Where<DiagnosisRow>> => {
      const filters: Where<DiagnosisRow> = {}
      const F = filters as Record<string, WhereValue>
      F.patient_id = q.patientId
      if (q.id) F.id = q.id
      if (q.ids) {
        const ids = q.ids
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
        if (ids.length > 0) F.id = { $in: ids }
      }
      if (q.status) F.status = q.status
      return filters
    },
    transformItem: (item: DiagnosisRow): DiagnosisItem => ({
      id: String(item.id),
      patientId: String(item.patient_id),
      title: item.title,
      description: item.description,
      diagnosedOn: toIsoDate(item.diagnosed_on),
      code: item.code ?? null,
      codeSystem: item.code_system ?? null,
      codeVersion: item.code_version ?? null,
      authorUserId: String(item.author_user_id),
      // Both filled in by `afterList`, batched for the whole page.
      author: null,
      supersedesId: item.supersedes_id ?? null,
      supersededById: null,
      status: item.status,
      voidReason: item.void_reason ?? null,
      voidedAt: toIsoTimestamp(item.voided_at),
      updatedAt: toIsoTimestamp(item.updated_at),
    }),
    allowCsv: false,
  },
  hooks: {
    /**
     * Fills in the author names and the forward chain link, in two queries for the page.
     *
     * `supersededById` is the inverse of `supersedes_id`, and the UI needs it to show "this
     * entry was corrected — open the correction". Deriving it only from rows on the current
     * page would be wrong whenever the successor falls on the next page, so it is resolved
     * with one scoped query over the page's ids rather than from the in-memory rows.
     */
    afterList: async (res: { items?: DiagnosisItem[] }, ctx: CrudCtx) => {
      const items = Array.isArray(res?.items) ? res.items : []
      if (items.length === 0) return
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
      if (!tenantId || !organizationId) return

      const references = ctx.container.resolve<PatientReferenceService>('patientReferenceService')
      const authors: Map<string, ResolvedReference> = await references.resolveUsers(
        items.map((item) => item.authorUserId),
        { tenantId, organizationId },
      )
      for (const item of items) {
        const author = authors.get(item.authorUserId)
        item.author = author
          ? { id: author.id, name: author.displayName, isAvailable: author.isAvailable }
          : null
      }

      const em = ctx.container.resolve<EntityManager>('em')
      const successors = await em.find(
        PatientDiagnosis,
        {
          tenantId,
          organizationId,
          deletedAt: null,
          supersedesId: { $in: items.map((item) => item.id) },
        } as FilterQuery<PatientDiagnosis>,
        { fields: ['id', 'supersedesId'] },
      )
      const successorByPredecessor = new Map<string, string>()
      for (const row of successors) {
        if (row.supersedesId) successorByPredecessor.set(String(row.supersedesId), String(row.id))
      }
      for (const item of items) {
        item.supersededById = successorByPredecessor.get(item.id) ?? null
      }
    },
  },
  actions: {
    create: {
      commandId: 'patient.diagnoses.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        id: String((result as { id: string }).id),
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
      status: 201,
    },
    // No `update` and no `delete`, and that is the contract rather than an omission: a
    // diagnosis is immutable once written. It is repaired through `[id]/correct`, which
    // supersedes it with a new entry, or withdrawn through `[id]/void`, which keeps the text
    // and records a reason. Exposing a generic PUT would let a client rewrite history in place
    // and a DELETE would destroy it.
  },
})

export const openApi: OpenApiRouteDoc = createPatientCrudOpenApi({
  resourceName: 'Patient diagnosis',
  pluralName: 'Patient diagnoses',
  querySchema,
  listResponseSchema: createPatientPagedListResponseSchema(patientDiagnosisItemSchema),
  create: {
    schema: rawBodySchema,
    description:
      'Records a diagnosis for one patient. The author is taken from the session, never the payload. `diagnosedOn` may be historical but not in the organization\'s future. An archived record refuses a new entry. Requires `clientRequestId`; a repeat with the same content returns the original entry. There is no update or delete — use `[id]/correct` or `[id]/void`.',
    responseSchema: patientCreatedSchema,
  },
})
