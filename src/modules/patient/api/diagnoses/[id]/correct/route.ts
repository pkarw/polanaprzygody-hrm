import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PatientDiagnosis } from '../../../../data/entities'
import { patientDiagnosisCorrectSchema } from '../../../../data/validators'
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
 * Corrects a diagnosis by superseding it with a new entry.
 *
 * A guarded command action rather than a PUT on the collection, because the result is not an
 * edit: the original entry keeps its text, its date and its author, and a NEW entry is
 * inserted pointing back at it. A PUT would invite exactly the in-place rewrite the spec
 * forbids.
 *
 * `expectedUpdatedAt` is the version of the entry being superseded, so two clinicians
 * correcting the same entry cannot both win — the second gets a 409 rather than forking the
 * history into two competing successors.
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

    // `authorUserId` and `supersedesId` are both on the protected list: the author of a
    // correction is the authenticated user, and what it supersedes is the path id.
    rejectProtectedKeys(body, translate)

    const parsed = parseScopedCommandInput(patientDiagnosisCorrectSchema, body, ctx, translate)

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result, logEntry } = await commandBus.execute<Record<string, unknown>, PatientDiagnosis>(
      'patient.diagnoses.correct',
      { input: { ...parsed, id: params.id }, ctx },
    )

    const response = NextResponse.json(
      {
        ok: true as const,
        // The id of the NEW entry. The client navigates to the correction rather than
        // re-reading the entry it just superseded.
        id: String(result.id),
        supersedesId: params.id,
        updatedAt: toIsoTimestamp(result.updatedAt),
      },
      { status: 201 },
    )
    return attachOperationMetadata(response, logEntry, 'patient.patient_diagnosis')
  } catch (err) {
    return toPatientErrorResponse(err, translateFn, 'diagnoses.correct')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Correct a diagnosis',
  methods: {
    POST: {
      summary: 'Correct a diagnosis',
      description:
        'Inserts a new diagnosis superseding this one, in a single transaction. The original keeps its text, date and author and moves to `superseded`. Only the active, latest entry of a chain can be corrected — an already-superseded or voided entry returns 409. Requires `expectedUpdatedAt` and `clientRequestId`.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientDiagnosisCorrectSchema },
      responses: [
        {
          status: 201,
          description: 'The correction was recorded.',
          schema: z.object({
            ok: z.literal(true),
            id: z.string().uuid(),
            supersedesId: z.string().uuid(),
            updatedAt: z.string().nullable(),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid payload, missing version token, or a server-owned field was supplied', schema: patientErrorSchema },
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'patient.clinical.manage is not granted', schema: patientErrorSchema },
        { status: 404, description: 'The entry is not visible in this scope', schema: patientErrorSchema },
        { status: 409, description: 'Stale version, the entry is not the latest active one, or it was corrected concurrently', schema: patientErrorSchema },
        { status: 422, description: 'The diagnosis date is in the future', schema: patientErrorSchema },
        { status: 503, description: 'Encryption for patient data is unavailable', schema: patientErrorSchema },
      ],
    },
  },
}
