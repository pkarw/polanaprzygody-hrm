import { z } from 'zod'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { Where, WhereValue } from '@open-mercato/shared/lib/query/types'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  customer_entity_id,
  id as idField,
  is_contact,
  is_guardian,
  is_payer,
  is_primary_contact,
  organization_id,
  patient_id,
  relationship_label,
  tenant_id,
  updated_at,
} from '@/.mercato/generated/entities/patient_contact_link'
import { PatientContactLink } from '../../data/entities'
import { toIsoTimestamp } from '../../lib/commandSupport'
import type { PatientReferenceService, ResolvedReference } from '../../lib/patientReferenceService'
import { buildDeleteCommandInput } from '../../lib/deleteInput'
import { PATIENT_PROTECTED_KEYS } from '../../lib/routeSupport'
import {
  createPatientCrudOpenApi,
  createPatientPagedListResponseSchema,
  patientContactItemSchema,
  patientCreatedSchema,
  patientOkSchema,
} from '../openapi'
import '../../commands/contacts'

const ENTITY_ID = 'patient:patient_contact_link' as const

/** Anchored to a parent for the same reason addresses are — see that route's note. */
const querySchema = z
  .object({
    patientId: z.string().uuid(),
    id: z.string().uuid().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional().default('is_primary_contact'),
    sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
  })
  .passthrough()

type Query = z.infer<typeof querySchema>

const rawBodySchema = z.object({}).passthrough()

const sortFieldMap: Record<string, string> = {
  id: idField,
  is_primary_contact,
  isPrimaryContact: is_primary_contact,
  updated_at,
  updatedAt: updated_at,
}

type ContactRow = {
  id: string
  patient_id: string
  customer_entity_id: string
  is_guardian: boolean
  is_contact: boolean
  is_payer: boolean
  is_primary_contact: boolean
  relationship_label: string | null
  updated_at: Date | string | null
}

type ContactItem = {
  id: string
  patientId: string
  customerEntityId: string
  person: { id: string; name: string; isAvailable: boolean } | null
  isGuardian: boolean
  isContact: boolean
  isPayer: boolean
  isPrimaryContact: boolean
  relationshipLabel: string | null
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

export const { metadata, GET, POST, PUT, DELETE } = makeCrudRoute({
  metadata: {
    GET: { requireAuth: true, requireFeatures: ['patient.patients.view'] },
    POST: { requireAuth: true, requireFeatures: ['patient.patients.manage'] },
    PUT: { requireAuth: true, requireFeatures: ['patient.patients.manage'] },
    DELETE: { requireAuth: true, requireFeatures: ['patient.patients.manage'] },
  },
  orm: {
    entity: PatientContactLink,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  events: { module: 'patient', entity: 'contact', persistent: true },
  indexer: { entityType: ENTITY_ID },
  list: {
    schema: querySchema,
    entityId: ENTITY_ID,
    fields: () => [
      idField,
      patient_id,
      customer_entity_id,
      is_guardian,
      is_contact,
      is_payer,
      is_primary_contact,
      relationship_label,
      tenant_id,
      organization_id,
      updated_at,
    ],
    sortFieldMap,
    buildFilters: async (q: Query): Promise<Where<ContactRow>> => {
      const filters: Where<ContactRow> = {}
      const F = filters as Record<string, WhereValue>
      F.patient_id = q.patientId
      if (q.id) F.id = q.id
      return filters
    },
    transformItem: (item: ContactRow): ContactItem => ({
      id: String(item.id),
      patientId: String(item.patient_id),
      customerEntityId: String(item.customer_entity_id),
      // Resolved for the whole page at once in `afterList`.
      person: null,
      isGuardian: Boolean(item.is_guardian),
      isContact: Boolean(item.is_contact),
      isPayer: Boolean(item.is_payer),
      isPrimaryContact: Boolean(item.is_primary_contact),
      relationshipLabel: item.relationship_label ?? null,
      updatedAt: toIsoTimestamp(item.updated_at),
    }),
    allowCsv: false,
  },
  hooks: {
    /**
     * Resolves every linked person's display name in one query for the page.
     *
     * The name is resolved here rather than stored on the link, so a CRM edit is reflected
     * on the next read and identifying data stays in one place. A person who has since been
     * deactivated still resolves, with `isAvailable: false`, so the relationship stays
     * legible; one that is no longer in scope resolves to `null` and renders as unavailable
     * rather than as a raw uuid.
     */
    afterList: async (res: { items?: ContactItem[] }, ctx: CrudCtx) => {
      const items = Array.isArray(res?.items) ? res.items : []
      if (items.length === 0) return
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
      if (!tenantId || !organizationId) return

      const references = ctx.container.resolve<PatientReferenceService>('patientReferenceService')
      const resolved: Map<string, ResolvedReference> = await references.resolveCrmPeople(
        items.map((item) => item.customerEntityId),
        { tenantId, organizationId },
      )
      for (const item of items) {
        const reference = resolved.get(item.customerEntityId)
        item.person = reference
          ? { id: reference.id, name: reference.displayName, isAvailable: reference.isAvailable }
          : null
      }
    },
  },
  actions: {
    create: {
      commandId: 'patient.contacts.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        id: String((result as { id: string }).id),
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
      status: 201,
    },
    update: {
      commandId: 'patient.contacts.update',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as { id: string }).id),
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
    },
    delete: {
      commandId: 'patient.contacts.delete',
      // DELETE is handed `{ body, query }` rather than the body; see the helper.
      mapInput: ({ raw, ctx }) => buildDeleteCommandInput(raw, ctx.request),
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as { id: string }).id),
        deleted: true as const,
      }),
    },
  },
})

const contactDeleteBodySchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

export const openApi: OpenApiRouteDoc = createPatientCrudOpenApi({
  resourceName: 'Patient contact link',
  pluralName: 'Patient contact links',
  querySchema,
  listResponseSchema: createPatientPagedListResponseSchema(patientContactItemSchema),
  create: {
    schema: rawBodySchema,
    description:
      'Links a CRM person to a patient with one or more independent role flags. The person must be an active `customer_entity` of kind `person` in this scope (422 otherwise). A second simultaneously active link for the same pair returns 409.',
    responseSchema: patientCreatedSchema,
  },
  update: {
    schema: rawBodySchema,
    description:
      'Replaces the complete set of role flags. Requires `expectedUpdatedAt`. `customerEntityId` cannot be changed — re-pointing a link would rewrite who is recorded as guardian, so changing the person is an unlink plus a link.',
    responseSchema: patientOkSchema,
  },
  del: {
    schema: contactDeleteBodySchema,
    description:
      'Unlinks a contact. Soft-deletes the LINK only; the CRM person is untouched. A patient may end up with zero contacts.',
    responseSchema: patientOkSchema,
  },
})
