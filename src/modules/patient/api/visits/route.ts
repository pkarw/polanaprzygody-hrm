import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { Where, WhereValue } from '@open-mercato/shared/lib/query/types'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import {
  confirmed_at,
  conflict_override_at,
  conflict_override_by_user_id,
  conflict_override_codes,
  conflict_override_reason,
  description as descriptionField,
  ends_at,
  id as idField,
  is_settled,
  organization_id,
  patient_id,
  resource_id,
  resource_name_snapshot,
  settled_at,
  starts_at,
  status as statusField,
  team_member_id,
  team_member_name_snapshot,
  tenant_id,
  time_zone,
  updated_at,
} from '@/.mercato/generated/entities/patient_visit'
import { Patient, PatientVisit, PatientVisitService } from '../../data/entities'
import '../../commands/visits'
import {
  patientVisitCreateSchema,
  patientVisitDeleteSchema,
  patientVisitListOpenApiQuerySchema,
  patientVisitListQuerySchema,
  patientVisitUpdateSchema,
} from '../../data/validators'
import { toIsoTimestamp } from '../../lib/commandSupport'
import { buildDeleteCommandInput } from '../../lib/deleteInput'
import { PATIENT_PROTECTED_KEYS } from '../../lib/routeSupport'
import { isVisitDetailQuery } from '../../lib/visitApi'
import {
  PATIENT_REFERENCE_SERVICE,
} from '../../di'
import type { PatientReferenceService } from '../../lib/patientReferenceService'
import type { ResolvedReference } from '../../lib/patientReferenceService'
import type { PatientVisitItem, PatientVisitServiceItem } from '../../types'
import {
  createPatientCrudOpenApi,
  createPatientPagedListResponseSchema,
  patientVisitCreatedSchema,
  patientVisitDeletedResultSchema,
  patientVisitListItemSchema,
  patientVisitVersionedResultSchema,
} from '../openapi'

const ENTITY_ID = 'patient:patient_visit' as const

const querySchema = patientVisitListQuerySchema

type Query = z.infer<typeof querySchema>

const rawBodySchema = z.object({}).passthrough()

const VISIT_PROTECTED_KEYS = [
  ...PATIENT_PROTECTED_KEYS,
  'confirmedAt',
  'confirmedByUserId',
  'isConfirmed',
  'confirmationApplicable',
  'isSettled',
  'settledAt',
  'settledByUserId',
  'statusChangedAt',
  'statusChangedByUserId',
  'statusReason',
  'settlementReason',
  'conflictOverrideReason',
  'conflictOverrideAt',
  'conflictOverrideByUserId',
  'conflictOverrideCodes',
] as const

type VisitRow = {
  id: string
  patient_id: string
  team_member_id: string
  team_member_name_snapshot: string
  resource_id: string | null
  resource_name_snapshot: string | null
  starts_at: Date | string
  ends_at: Date | string | null
  time_zone: string
  description?: string | null
  status: 'planned' | 'completed' | 'cancelled' | 'no_show'
  confirmed_at: Date | string | null
  conflict_override_at: Date | string | null
  conflict_override_by_user_id: string | null
  conflict_override_codes: string[] | null
  conflict_override_reason?: string | null
  is_settled: boolean
  settled_at: Date | string | null
  updated_at: Date | string
}

type VisitItem = PatientVisitItem & { description?: string | null }

function requiredIsoTimestamp(value: Date | string, field: string): string {
  const timestamp = toIsoTimestamp(value)
  if (!timestamp) {
    throw new CrudHttpError(500, { error: `Stored visit ${field} is invalid` })
  }
  return timestamp
}

async function rejectServerOwnedKeys(parsed: Record<string, unknown>): Promise<Record<string, unknown>> {
  const present = VISIT_PROTECTED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(parsed, key))
  if (present.length > 0) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(400, {
      error: translate(
        'patient.errors.visitProtectedFields',
        'These visit fields are set by the server and cannot be supplied',
      ),
      fields: present,
    })
  }
  return parsed
}

const sortFieldMap: Record<string, string> = {
  id: idField,
  starts_at,
  startsAt: starts_at,
  ends_at,
  endsAt: ends_at,
  status: statusField,
  is_settled,
  isSettled: is_settled,
  updated_at,
  updatedAt: updated_at,
}

export const { metadata, GET, POST, PUT, DELETE } = makeCrudRoute({
  metadata: {
    GET: { requireAuth: true, requireFeatures: ['patient.visits.view', 'patient.patients.view'] },
    POST: { requireAuth: true, requireFeatures: ['patient.visits.manage'] },
    PUT: { requireAuth: true, requireFeatures: ['patient.visits.manage'] },
    DELETE: { requireAuth: true, requireFeatures: ['patient.visits.manage'] },
  },
  orm: {
    entity: PatientVisit,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  events: { module: 'patient', entity: 'visit', persistent: true },
  list: {
    schema: querySchema,
    entityId: ENTITY_ID,
    fields: (query: Query) => [
      idField,
      patient_id,
      team_member_id,
      team_member_name_snapshot,
      resource_id,
      resource_name_snapshot,
      starts_at,
      ends_at,
      time_zone,
      ...(isVisitDetailQuery(query) ? [descriptionField] : []),
      statusField,
      confirmed_at,
      conflict_override_at,
      conflict_override_by_user_id,
      conflict_override_codes,
      ...(isVisitDetailQuery(query) ? [conflict_override_reason] : []),
      is_settled,
      settled_at,
      tenant_id,
      organization_id,
      updated_at,
    ],
    sortFieldMap,
    defaultSort: { field: starts_at, dir: 'asc' },
    tiebreakSortField: idField,
    buildFilters: async (q: Query): Promise<Where<VisitRow>> => {
      const filters: Where<VisitRow> = {}
      const F = filters as Record<string, WhereValue>
      if (q.id) F.id = q.id
      if (q.ids) {
        const ids = Array.from(new Set(q.ids.split(',').map((value) => value.trim()).filter(Boolean)))
        if (ids.length > 0) F.id = { $in: ids }
      }
      if (q.patientId) F.patient_id = q.patientId
      if (q.teamMemberId) F.team_member_id = q.teamMemberId
      if (q.resourceId) F.resource_id = q.resourceId
      if (q.status) F.status = q.status
      if (q.isSettled) F.is_settled = q.isSettled === 'true'
      if (q.from || q.to) {
        F.starts_at = {
          ...(q.from ? { $gte: new Date(q.from) } : {}),
          ...(q.to ? { $lt: new Date(q.to) } : {}),
        }
      }
      return filters
    },
    transformItem: (item: VisitRow): VisitItem => {
      const confirmedAt = toIsoTimestamp(item.confirmed_at)
      return {
        id: String(item.id),
        patientId: String(item.patient_id),
        patientName: null,
        teamMemberId: String(item.team_member_id),
        teamMemberName: item.team_member_name_snapshot,
        resourceId: item.resource_id ?? null,
        resourceName: item.resource_name_snapshot ?? null,
        startsAt: requiredIsoTimestamp(item.starts_at, 'start'),
        endsAt: toIsoTimestamp(item.ends_at),
        timeZone: item.time_zone,
        ...(item.description !== undefined ? { description: item.description ?? null } : {}),
        status: item.status,
        confirmedAt,
        conflictOverrideAt: toIsoTimestamp(item.conflict_override_at),
        conflictOverrideByUserId: item.conflict_override_by_user_id ?? null,
        conflictOverrideByUserName: null,
        conflictOverrideCodes: Array.isArray(item.conflict_override_codes)
          ? item.conflict_override_codes.filter((code): code is string => typeof code === 'string')
          : null,
        ...(item.conflict_override_reason !== undefined
          ? { conflictOverrideReason: item.conflict_override_reason ?? null }
          : {}),
        isConfirmed: confirmedAt !== null,
        confirmationApplicable: item.status === 'planned',
        isSettled: Boolean(item.is_settled),
        settledAt: toIsoTimestamp(item.settled_at),
        services: [],
        updatedAt: requiredIsoTimestamp(item.updated_at, 'version'),
      }
    },
    allowCsv: false,
  },
  hooks: {
    /** Enriches one page with two bounded queries: current patient names and ordered services. */
    afterList: async (res: { items?: VisitItem[] }, ctx: CrudCtx) => {
      const items = Array.isArray(res?.items) ? res.items : []
      if (items.length === 0) return
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
      if (!tenantId || !organizationId) return
      const em = ctx.container.resolve<EntityManager>('em')
      const visitIds = items.map((item) => item.id)
      const patientIds = Array.from(new Set(items.map((item) => item.patientId)))

      const [patients, services] = await Promise.all([
        findWithDecryption(
          em,
          Patient,
          {
            id: { $in: patientIds },
            tenantId,
            organizationId,
          } as FilterQuery<Patient>,
          { fields: ['id', 'firstName', 'lastName'] },
          { tenantId, organizationId },
        ),
        findWithDecryption(
          em,
          PatientVisitService,
          {
            visitId: { $in: visitIds },
            tenantId,
            organizationId,
            deletedAt: null,
          } as FilterQuery<PatientVisitService>,
          { orderBy: { visitId: 'asc', position: 'asc' } },
          { tenantId, organizationId },
        ),
      ])

      const patientNameById = new Map<string, string | null>()
      for (const patient of patients) {
        const name = [patient.firstName, patient.lastName]
          .filter((part): part is string => typeof part === 'string' && part.length > 0)
          .join(' ')
        patientNameById.set(String(patient.id), name.length > 0 ? name : null)
      }
      const productIds = Array.from(new Set(services.map((service) => String(service.productId))))
      const references = ctx.container.resolve<PatientReferenceService>(PATIENT_REFERENCE_SERVICE)
      const overrideUserIds = Array.from(new Set(items
        .map((item) => item.conflictOverrideByUserId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)))
      const [products, overrideUsers]: [Map<string, { isAvailable: boolean }>, Map<string, ResolvedReference>] = await Promise.all([
        productIds.length > 0
          ? references.resolveProducts(productIds, { tenantId, organizationId })
          : new Map(),
        overrideUserIds.length > 0
          ? references.resolveUsers(overrideUserIds, { tenantId, organizationId })
          : new Map(),
      ])
      const servicesByVisit = new Map<string, PatientVisitServiceItem[]>()
      for (const service of services) {
        const visitId = String(service.visitId)
        const list = servicesByVisit.get(visitId) ?? []
        list.push({
          id: String(service.id),
          productId: String(service.productId),
          title: String(service.productTitleSnapshot),
          sku: service.productSkuSnapshot ?? null,
          isAvailable: products.get(String(service.productId))?.isAvailable ?? false,
          position: Number(service.position),
        })
        servicesByVisit.set(visitId, list)
      }
      for (const item of items) {
        item.patientName = patientNameById.get(item.patientId) ?? null
        item.services = servicesByVisit.get(item.id) ?? []
        item.conflictOverrideByUserName = item.conflictOverrideByUserId
          ? overrideUsers.get(item.conflictOverrideByUserId)?.displayName ?? null
          : null
      }
    },
  },
  actions: {
    create: {
      commandId: 'patient.visits.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        id: String((result as PatientVisit).id),
        status: (result as PatientVisit).status,
        confirmedAt: toIsoTimestamp((result as PatientVisit).confirmedAt),
        isSettled: Boolean((result as PatientVisit).isSettled),
        updatedAt: requiredIsoTimestamp((result as PatientVisit).updatedAt, 'version'),
      }),
      status: 201,
    },
    update: {
      commandId: 'patient.visits.update',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as PatientVisit).id),
        updatedAt: requiredIsoTimestamp((result as PatientVisit).updatedAt, 'version'),
      }),
    },
    delete: {
      commandId: 'patient.visits.delete',
      mapInput: ({ raw, ctx }) => buildDeleteCommandInput(raw, ctx.request),
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as PatientVisit).id),
        deleted: true as const,
        updatedAt: requiredIsoTimestamp((result as PatientVisit).updatedAt, 'version'),
      }),
    },
  },
})

export const openApi: OpenApiRouteDoc = createPatientCrudOpenApi({
  resourceName: 'Patient visit',
  pluralName: 'Patient visits',
  querySchema: patientVisitListOpenApiQuerySchema,
  listResponseSchema: createPatientPagedListResponseSchema(patientVisitListItemSchema),
  create: {
    schema: patientVisitCreateSchema,
    description:
      'Schedules a planned visit with zero or more active catalog products. Scope, actor, reference snapshots, status, confirmation and settlement fields are server-owned. Requires an idempotent clientRequestId.',
    responseSchema: patientVisitCreatedSchema,
  },
  update: {
    schema: patientVisitUpdateSchema,
    description:
      'Updates an editable planned visit with optimistic concurrency. Omitted serviceProductIds preserves the list; an empty array removes every service. Scheduling changes atomically clear confirmation.',
    responseSchema: patientVisitVersionedResultSchema,
  },
  del: {
    schema: patientVisitDeleteSchema,
    description: 'Soft-deletes only a planned, unsettled visit and its active service rows.',
    responseSchema: patientVisitDeletedResultSchema,
  },
})
