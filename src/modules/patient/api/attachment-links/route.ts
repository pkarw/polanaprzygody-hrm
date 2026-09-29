import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { Where, WhereValue } from '@open-mercato/shared/lib/query/types'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  attachment_id,
  diagnosis_id,
  id as idField,
  organization_id,
  original_file_name,
  patient_id,
  state as stateField,
  tenant_id,
  updated_at,
} from '@/.mercato/generated/entities/patient_attachment_link'
import { PatientAttachmentLink } from '../../data/entities'
import { toIsoTimestamp } from '../../lib/commandSupport'
import { PATIENT_PROTECTED_KEYS } from '../../lib/routeSupport'
import {
  createPatientCrudOpenApi,
  createPatientPagedListResponseSchema,
  patientAttachmentLinkItemSchema,
  patientCreatedSchema,
  patientOkSchema,
} from '../openapi'
import '../../commands/attachment-links'

const ENTITY_ID = 'patient:patient_attachment_link' as const

/**
 * Reading file LINKS is not gated on SEC-ATT; creating them is.
 *
 * The list returns link rows and the encrypted label — metadata this module owns and protects
 * with its own clinical feature. It returns no bytes and no storage URL, so it is not a way
 * around the missing host protection. Writing a link IS refused while the gate is closed, in the
 * command, because a link is what makes a file look like protected clinical documentation.
 *
 * Keeping the read open matters for a deployment that enabled files on a host that later
 * regressed: the operator can still see and detach what exists.
 */
const querySchema = z
  .object({
    patientId: z.string().uuid(),
    diagnosisId: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional().default('updated_at'),
    sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
  })
  .passthrough()

type Query = z.infer<typeof querySchema>

const rawBodySchema = z.object({}).passthrough()

const sortFieldMap: Record<string, string> = {
  id: idField,
  updated_at,
  updatedAt: updated_at,
}

type AttachmentLinkRow = {
  id: string
  patient_id: string
  attachment_id: string
  diagnosis_id: string | null
  original_file_name: string | null
  state: 'active' | 'detached'
  updated_at: Date | string | null
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
    entity: PatientAttachmentLink,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  events: { module: 'patient', entity: 'attachment_link', persistent: true },
  indexer: { entityType: ENTITY_ID },
  list: {
    schema: querySchema,
    entityId: ENTITY_ID,
    fields: () => [
      idField,
      patient_id,
      attachment_id,
      diagnosis_id,
      original_file_name,
      stateField,
      tenant_id,
      organization_id,
      updated_at,
    ],
    sortFieldMap,
    buildFilters: async (q: Query): Promise<Where<AttachmentLinkRow>> => {
      const filters: Where<AttachmentLinkRow> = {}
      const F = filters as Record<string, WhereValue>
      F.patient_id = q.patientId
      if (q.id) F.id = q.id
      // Absent means "every file of this patient", which the card's Files tab shows with each
      // row's source marked. Present narrows to one diagnosis entry's files.
      if (q.diagnosisId) F.diagnosis_id = q.diagnosisId
      return filters
    },
    transformItem: (item: AttachmentLinkRow) => ({
      id: String(item.id),
      patientId: String(item.patient_id),
      diagnosisId: item.diagnosis_id ?? null,
      attachmentId: String(item.attachment_id),
      fileName: item.original_file_name ?? null,
      state: item.state,
      updatedAt: toIsoTimestamp(item.updated_at),
    }),
    allowCsv: false,
  },
  actions: {
    create: {
      commandId: 'patient.attachment_links.create',
      schema: rawBodySchema,
      mapInput: ({ parsed }) => rejectServerOwnedKeys(parsed as Record<string, unknown>),
      response: ({ result }) => ({
        id: String((result as { id: string }).id),
        updatedAt: toIsoTimestamp((result as { updatedAt?: Date }).updatedAt),
      }),
      status: 201,
    },
    delete: {
      commandId: 'patient.attachment_links.delete',
      response: ({ result }) => ({
        ok: true as const,
        id: String((result as { id: string }).id),
        deleted: true as const,
      }),
    },
  },
})

const attachmentLinkDeleteBodySchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().min(1),
})

export const openApi: OpenApiRouteDoc = createPatientCrudOpenApi({
  resourceName: 'Patient file link',
  pluralName: 'Patient file links',
  querySchema,
  listResponseSchema: createPatientPagedListResponseSchema(patientAttachmentLinkItemSchema),
  create: {
    schema: rawBodySchema,
    description:
      'Links a stored file to a patient, or to one of that patient\'s diagnoses. Returns 503 with `code: clinical_file_protection_unavailable` while the installed attachments module authorizes downloads by scope alone — see the SEC-ATT note in `lib/clinicalFileGate.ts`. A `diagnosisId` belonging to another patient returns 422.',
    responseSchema: patientCreatedSchema,
  },
  del: {
    schema: attachmentLinkDeleteBodySchema,
    description:
      'Detaches a file. Soft-deletes the LINK and marks it detached; the stored file is never removed. Not gated on SEC-ATT — detaching can only narrow exposure, so it stays available even while attaching is refused.',
    responseSchema: patientOkSchema,
  },
})
