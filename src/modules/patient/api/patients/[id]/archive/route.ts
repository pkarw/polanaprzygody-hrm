import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { Patient } from '../../../../data/entities'
import {
  attachOperationMetadata,
  buildPatientRouteContext,
  rejectProtectedKeys,
  toPatientErrorResponse,
} from '../../../../lib/routeSupport'
import { toIsoTimestamp } from '../../../../lib/commandSupport'
import { patientErrorSchema, patientTag, patientVersionedResultSchema } from '../../../openapi'
import '../../../../commands/patients'

/**
 * Archives or restores a patient record.
 *
 * Its own endpoint rather than a field on `PUT /api/patient/patients`, for the same reason
 * the command is separate: `status` and `archived_at` are one fact in two columns, and
 * archiving is the gate that stops new entries being accepted. Reachable through the
 * generic update, that gate would have a second entry point whose invariant nobody checks.
 * The generic route answers a payload containing `status` with a 400 for the same reason.
 *
 * The feature is `patient.patients.manage` — archiving is a records-administration action,
 * not a clinical one. It does not touch history: diagnoses, documents and files stay
 * readable afterwards, and a correction or void is still permitted with the clinical
 * feature.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['patient.patients.manage'] },
}

const archiveBodySchema = z.object({
  archived: z.boolean(),
  expectedUpdatedAt: z.string().min(1),
})

export async function POST(req: Request, routeCtx: { params: { id: string } | Promise<{ id: string }> }) {
  let translateFn: (key: string, fallback?: string) => string = (_key, fallback) => fallback ?? ''
  try {
    const { ctx, translate } = await buildPatientRouteContext(req)
    translateFn = translate
    const params = await routeCtx.params
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    // `status` and `archivedAt` are rejected even here: this endpoint takes the intent
    // (`archived: boolean`) and derives both columns itself, so a caller supplying either
    // one is working from a wrong model of the contract and should be told, not ignored.
    rejectProtectedKeys(body, translate)

    const parsed = parseScopedCommandInput(archiveBodySchema, body, ctx, translate)

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result, logEntry } = await commandBus.execute<Record<string, unknown>, Patient>(
      'patient.patients.archive',
      { input: { ...parsed, id: params.id }, ctx },
    )

    const response = NextResponse.json(
      {
        ok: true as const,
        id: String(result.id),
        status: result.status,
        updatedAt: toIsoTimestamp(result.updatedAt),
      },
      { status: 200 },
    )
    return attachOperationMetadata(response, logEntry, 'patient.patient')
  } catch (err) {
    return toPatientErrorResponse(err, translateFn, 'patients.archive')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Archive or restore a patient record',
  methods: {
    POST: {
      summary: 'Archive or restore a patient record',
      description:
        'Sets `status` and `archived_at` together. An archived record accepts no new addresses, contacts, diagnoses or documentation links, but stays fully readable and still permits a diagnosis correction or void with the clinical feature. Requires `expectedUpdatedAt`; a repeat of the current state returns 409.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: archiveBodySchema },
      responses: [
        {
          status: 200,
          description: 'The record was archived or restored.',
          schema: patientVersionedResultSchema.extend({ status: z.enum(['active', 'archived']) }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid payload, missing version token, or a server-owned field was supplied', schema: patientErrorSchema },
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'patient.patients.manage is not granted, or the payload targets another tenant', schema: patientErrorSchema },
        { status: 404, description: 'The record is not visible in this scope', schema: patientErrorSchema },
        { status: 409, description: 'Stale version, or the record is already in the requested state', schema: patientErrorSchema },
      ],
    },
  },
}
