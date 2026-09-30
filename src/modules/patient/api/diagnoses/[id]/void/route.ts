import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PatientDiagnosis } from '../../../../data/entities'
import { patientDiagnosisVoidSchema } from '../../../../data/validators'
import {
  attachOperationMetadata,
  buildPatientRouteContext,
  rejectProtectedKeys,
  toPatientErrorResponse,
} from '../../../../lib/routeSupport'
import { toIsoTimestamp } from '../../../../lib/commandSupport'
import { patientErrorSchema, patientTag } from '../../../openapi'
import '../../../../commands/diagnoses'

/**
 * Voids a diagnosis.
 *
 * Deliberately not a DELETE. Voiding keeps the entry and its text, records who withdrew it,
 * when, and why — the spec bans destroying clinical history, and an entry that was acted on
 * clinically must remain readable even once it is withdrawn.
 *
 * The reason is required by the schema and stored in an encrypted column. It is not echoed
 * into the action log, whose storage is not guaranteed to protect free text.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['patient.clinical.manage'] },
}

export async function POST(req: Request, routeCtx: { params: { id: string } | Promise<{ id: string }> }) {
  let translateFn: (key: string, fallback?: string) => string = (_key, fallback) => fallback ?? ''
  try {
    const { ctx, translate } = await buildPatientRouteContext(req)
    translateFn = translate
    const params = await routeCtx.params
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    // `voidedAt`, `voidedByUserId` and `voidReason` are on the protected list — the first two
    // are server-side facts, and the reason has to arrive under its own `reason` key so the
    // schema can require it rather than accept a silently absent one.
    rejectProtectedKeys(body, translate)

    const parsed = parseScopedCommandInput(patientDiagnosisVoidSchema, body, ctx, translate)

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result, logEntry } = await commandBus.execute<Record<string, unknown>, PatientDiagnosis>(
      'patient.diagnoses.void',
      { input: { ...parsed, id: params.id }, ctx },
    )

    const response = NextResponse.json(
      {
        ok: true as const,
        id: String(result.id),
        status: result.status,
        voidedAt: toIsoTimestamp(result.voidedAt),
        updatedAt: toIsoTimestamp(result.updatedAt),
      },
      { status: 200 },
    )
    return attachOperationMetadata(response, logEntry, 'patient.patient_diagnosis')
  } catch (err) {
    return toPatientErrorResponse(err, translateFn, 'diagnoses.void')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Void a diagnosis',
  methods: {
    POST: {
      summary: 'Void a diagnosis',
      description:
        'Marks the entry as voided with a required reason. The title, description, date and author are kept — voiding withdraws an entry, it does not erase it. Permitted on an archived patient record, because it repairs history rather than adding to it. Requires `expectedUpdatedAt`.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientDiagnosisVoidSchema },
      responses: [
        {
          status: 200,
          description: 'The entry was voided.',
          schema: z.object({
            ok: z.literal(true),
            id: z.string().uuid(),
            status: z.literal('voided'),
            voidedAt: z.string().nullable(),
            updatedAt: z.string().nullable(),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid payload, a missing reason, or a server-owned field was supplied', schema: patientErrorSchema },
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'patient.clinical.manage is not granted', schema: patientErrorSchema },
        { status: 404, description: 'The entry is not visible in this scope', schema: patientErrorSchema },
        { status: 409, description: 'Stale version, or the entry is already voided', schema: patientErrorSchema },
        { status: 503, description: 'Encryption for patient data is unavailable', schema: patientErrorSchema },
      ],
    },
  },
}
