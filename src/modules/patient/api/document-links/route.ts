import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { Where, WhereValue } from '@open-mercato/shared/lib/query/types'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { Document } from '@open-mercato/documents/modules/documents/data/entities'
import {
  hasTier,
  resolveLoadedDocumentUserAccess,
} from '@open-mercato/documents/modules/documents/lib/permissions'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  document_id,
  id as idField,
  organization_id,
  patient_id,
  state as stateField,
  tenant_id,
  updated_at,
} from '@/.mercato/generated/entities/patient_document_link'
import { PatientDocumentLink } from '../../data/entities'
import { toIsoTimestamp } from '../../lib/commandSupport'
import { buildDeleteCommandInput } from '../../lib/deleteInput'
import { PATIENT_PROTECTED_KEYS } from '../../lib/routeSupport'
import {
  createPatientCrudOpenApi,
  createPatientPagedListResponseSchema,
  patientCreatedSchema,
  patientDocumentLinkItemSchema,
  patientOkSchema,
} from '../openapi'
import '../../commands/document-links'

const ENTITY_ID = 'patient:patient_document_link' as const

const querySchema = z
  .object({
    patientId: z.string().uuid(),
    id: z.string().uuid().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional().default('updated_at'),
    sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
    state: z.enum(['pending_create', 'linked', 'abandoned']).optional(),
  })
  .passthrough()

type Query = z.infer<typeof querySchema>

const rawBodySchema = z.object({}).passthrough()

const sortFieldMap: Record<string, string> = {
  id: idField,
  state: stateField,
  updated_at,
  updatedAt: updated_at,
}

type DocumentLinkRow = {
  id: string
  patient_id: string
  document_id: string
  state: 'pending_create' | 'linked' | 'abandoned'
  updated_at: Date | string | null
}

type DocumentLinkItem = {
  id: string
  patientId: string
  documentId: string
  state: 'pending_create' | 'linked' | 'abandoned'
  title: string | null
  isSharedWithOtherPatients: boolean
  updatedAt: string | null
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

export const { metadata, GET, POST, DELETE } = makeCrudRoute({
  metadata: {
    GET: { requireAuth: true, requireFeatures: ['patient.clinical.view'] },
    POST: { requireAuth: true, requireFeatures: ['patient.clinical.manage'] },
    DELETE: { requireAuth: true, requireFeatures: ['patient.clinical.manage'] },
  },
  orm: {
    entity: PatientDocumentLink,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  events: { module: 'patient', entity: 'document_link', persistent: true },
  indexer: { entityType: ENTITY_ID },
  list: {
    schema: querySchema,
    entityId: ENTITY_ID,
    // `creation_title` is deliberately NOT projected. It exists only while an intent is
    // pending, and the UI does not need it: the resume action carries the link id, and the
    // server reads the title from the row itself.
    fields: () => [idField, patient_id, document_id, stateField, tenant_id, organization_id, updated_at],
    sortFieldMap,
    buildFilters: async (q: Query): Promise<Where<DocumentLinkRow>> => {
      const filters: Where<DocumentLinkRow> = {}
      const F = filters as Record<string, WhereValue>
      F.patient_id = q.patientId
      if (q.id) F.id = q.id
      if (q.state) F.state = q.state
      return filters
    },
    transformItem: (item: DocumentLinkRow): DocumentLinkItem => ({
      id: String(item.id),
      patientId: String(item.patient_id),
      documentId: String(item.document_id),
      state: item.state,
      // Both resolved in `afterList`, where the documents module's own access policy decides
      // whether the title may be returned at all.
      title: null,
      isSharedWithOtherPatients: false,
      updatedAt: toIsoTimestamp(item.updated_at),
    }),
    allowCsv: false,
  },
  hooks: {
    /**
     * Resolves each document's title through the documents module's OWN access policy.
     *
     * A title is returned only when the caller passes that check; otherwise it stays `null` and
     * the UI renders a placeholder. The spec requires exactly this: pinning a document does not
     * grant access to it, and a caller who could not open the document must not learn its title
     * from the patient card.
     *
     * The documents are loaded in ONE scoped query and the per-document tier is then resolved
     * against the already-loaded row via `resolveLoadedDocumentUserAccess`, which is the host's
     * own helper for exactly this "many evaluations, one document row" shape — a plain
     * `resolveUserAccess` per item would re-read each document.
     *
     * `isSharedWithOtherPatients` is computed from this module's own links so the UI can warn
     * before unpinning that the document is attached elsewhere too.
     */
    afterList: async (res: { items?: DocumentLinkItem[] }, ctx: CrudCtx) => {
      const items = Array.isArray(res?.items) ? res.items : []
      if (items.length === 0) return
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
      const actorUserId = ctx.auth?.sub ?? null
      if (!tenantId || !organizationId || !actorUserId) return
      const scope = { tenantId, organizationId }

      const em = ctx.container.resolve<EntityManager>('em')
      const documentIds = Array.from(new Set(items.map((item) => item.documentId)))

      // `Document.title` is covered by the documents module's encryption map, so this read must
      // decrypt or the UI would receive ciphertext.
      const documents = await findWithDecryption(
        em,
        Document,
        {
          id: { $in: documentIds },
          tenantId,
          organizationId,
          deletedAt: null,
        } as FilterQuery<Document>,
        undefined,
        scope,
      )

      const titleByDocumentId = new Map<string, string>()
      for (const document of documents) {
        const tier = await resolveLoadedDocumentUserAccess(
          em,
          document,
          scope,
          actorUserId,
          ctx.container,
        )
        if (hasTier(tier, 'viewer')) titleByDocumentId.set(String(document.id), String(document.title))
      }

      const sharedCounts = await em.find(
        PatientDocumentLink,
        {
          tenantId,
          organizationId,
          deletedAt: null,
          documentId: { $in: documentIds },
        } as FilterQuery<PatientDocumentLink>,
        { fields: ['documentId', 'patientId'] },
      )
      const patientsPerDocument = new Map<string, Set<string>>()
      for (const row of sharedCounts) {
        const key = String(row.documentId)
        const set = patientsPerDocument.get(key) ?? new Set<string>()
        set.add(String(row.patientId))
        patientsPerDocument.set(key, set)
      }

      for (const item of items) {
        item.title = titleByDocumentId.get(item.documentId) ?? null
        item.isSharedWithOtherPatients = (patientsPerDocument.get(item.documentId)?.size ?? 0) > 1
      }
    },
  },
  actions: {
    create: {
      commandId: 'patient.document_links.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        id: String((result as { id: string }).id),
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
      status: 201,
    },
    delete: {
      commandId: 'patient.document_links.delete',
      // DELETE is handed `{ body, query }` rather than the body; see the helper.
      mapInput: ({ raw }) => buildDeleteCommandInput(raw),
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as { id: string }).id),
        deleted: true as const,
      }),
    },
    // No `update`: a link has nothing editable. Its state moves only through the dedicated
    // `new` / `[id]/resume` / `[id]/abandon` actions, each of which enforces which transitions
    // are legal.
  },
})

const documentLinkDeleteBodySchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

export const openApi: OpenApiRouteDoc = createPatientCrudOpenApi({
  resourceName: 'Patient document link',
  pluralName: 'Patient document links',
  querySchema,
  listResponseSchema: createPatientPagedListResponseSchema(patientDocumentLinkItemSchema),
  create: {
    schema: rawBodySchema,
    description:
      'Pins an EXISTING document to a patient. The caller must already be able to read the document under the documents module\'s own policy — pinning grants no access and creates no share. A document the caller cannot read returns 404 so an id cannot be probed.',
    responseSchema: patientCreatedSchema,
  },
  del: {
    schema: documentLinkDeleteBodySchema,
    description:
      'Unpins a document. Soft-deletes the LINK only; the document, its versions and its shares are untouched. An unfinished creation intent must be finished or abandoned first (409).',
    responseSchema: patientOkSchema,
  },
})
