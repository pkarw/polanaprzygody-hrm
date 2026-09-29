import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { Where, WhereValue } from '@open-mercato/shared/lib/query/types'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  address_line1,
  address_line2,
  building_number,
  city,
  company_name,
  country,
  flat_number,
  id as idField,
  is_primary,
  latitude,
  longitude,
  name as nameField,
  organization_id,
  patient_id,
  postal_code,
  purpose,
  region,
  tenant_id,
  updated_at,
} from '@/.mercato/generated/entities/patient_address'
import { PatientAddress } from '../../data/entities'
import { toIsoTimestamp } from '../../lib/commandSupport'
import { buildDeleteCommandInput } from '../../lib/deleteInput'
import { PATIENT_PROTECTED_KEYS } from '../../lib/routeSupport'
import {
  createPatientCrudOpenApi,
  createPatientPagedListResponseSchema,
  patientAddressItemSchema,
  patientCreatedSchema,
  patientOkSchema,
} from '../openapi'
import '../../commands/addresses'

const ENTITY_ID = 'patient:patient_address' as const

/**
 * `patientId` is required on every list request.
 *
 * An address list without a parent would be a cross-patient address book: scoped to the
 * organization, certainly, but still a way to read every patient's home address in one
 * page. Requiring the parent keeps every read anchored to a record the caller already
 * opened.
 */
const querySchema = z
  .object({
    patientId: z.string().uuid(),
    id: z.string().uuid().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional().default('is_primary'),
    sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
  })
  .passthrough()

type Query = z.infer<typeof querySchema>

const rawBodySchema = z.object({}).passthrough()

/**
 * Sortable columns.
 *
 * Every address text column is encrypted and therefore absent. `is_primary` first, then
 * `updated_at`, is what the shared editor renders: the primary address on top, the rest in
 * the order they were last touched.
 */
const sortFieldMap: Record<string, string> = {
  id: idField,
  is_primary,
  isPrimary: is_primary,
  updated_at,
  updatedAt: updated_at,
}

type AddressRow = {
  id: string
  patient_id: string
  name: string | null
  purpose: string | null
  company_name: string | null
  address_line1: string | null
  address_line2: string | null
  building_number: string | null
  flat_number: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
  latitude: string | null
  longitude: string | null
  is_primary: boolean
  updated_at: Date | string | null
}

/**
 * Decodes a stored coordinate back to a number.
 *
 * The column is `text` because it is encrypted, so the API — not the database — is where
 * it becomes a number again. A stored value that does not parse yields `null` rather than
 * `NaN`, which would serialize to JSON as `null` anyway but through a value no consumer
 * can test for.
 */
function toCoordinate(value: string | null): number | null {
  if (value == null || value.length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
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
    entity: PatientAddress,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  events: { module: 'patient', entity: 'address', persistent: true },
  indexer: { entityType: ENTITY_ID },
  list: {
    schema: querySchema,
    entityId: ENTITY_ID,
    fields: () => [
      idField,
      patient_id,
      nameField,
      purpose,
      company_name,
      address_line1,
      address_line2,
      building_number,
      flat_number,
      city,
      region,
      postal_code,
      country,
      latitude,
      longitude,
      is_primary,
      tenant_id,
      organization_id,
      updated_at,
    ],
    sortFieldMap,
    buildFilters: async (q: Query): Promise<Where<AddressRow>> => {
      const filters: Where<AddressRow> = {}
      const F = filters as Record<string, WhereValue>
      F.patient_id = q.patientId
      if (q.id) F.id = q.id
      return filters
    },
    transformItem: (item: AddressRow) => ({
      id: String(item.id),
      patientId: String(item.patient_id),
      name: item.name ?? null,
      purpose: item.purpose ?? null,
      companyName: item.company_name ?? null,
      addressLine1: item.address_line1 ?? '',
      addressLine2: item.address_line2 ?? null,
      buildingNumber: item.building_number ?? null,
      flatNumber: item.flat_number ?? null,
      city: item.city ?? null,
      region: item.region ?? null,
      postalCode: item.postal_code ?? null,
      country: item.country ?? null,
      latitude: toCoordinate(item.latitude),
      longitude: toCoordinate(item.longitude),
      isPrimary: Boolean(item.is_primary),
      updatedAt: toIsoTimestamp(item.updated_at),
    }),
    allowCsv: false,
  },
  actions: {
    create: {
      commandId: 'patient.addresses.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        id: String((result as { id: string }).id),
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
      status: 201,
    },
    update: {
      commandId: 'patient.addresses.update',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as { id: string }).id),
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
    },
    delete: {
      commandId: 'patient.addresses.delete',
      // DELETE is handed `{ body, query }` rather than the body; see the helper.
      mapInput: ({ raw }) => buildDeleteCommandInput(raw),
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as { id: string }).id),
        deleted: true as const,
      }),
    },
  },
})

const addressDeleteBodySchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

export const openApi: OpenApiRouteDoc = createPatientCrudOpenApi({
  resourceName: 'Patient address',
  pluralName: 'Patient addresses',
  querySchema,
  listResponseSchema: createPatientPagedListResponseSchema(patientAddressItemSchema),
  create: {
    schema: rawBodySchema,
    description:
      'Adds an address. `isPrimary: true` promotes it and demotes the current primary in the same transaction. The first address of a record with none is promoted automatically.',
    responseSchema: patientCreatedSchema,
  },
  update: {
    schema: rawBodySchema,
    description:
      'Updates an address. Requires `expectedUpdatedAt`. `isPrimary` accepts only `true` — an active record must always have exactly one primary address, so the way to change which one it is is to promote another.',
    responseSchema: patientOkSchema,
  },
  del: {
    schema: addressDeleteBodySchema,
    description:
      'Soft-deletes an address. Refused with 409 for the last address of an active record, and for the primary address while others remain — promote another first.',
    responseSchema: patientOkSchema,
  },
})
