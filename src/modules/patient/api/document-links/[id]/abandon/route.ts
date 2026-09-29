import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PatientDocumentLink } from '../../../../data/entities'
import { patientDocumentLinkResumeSchema } from '../../../../data/validators'
import {
  attachOperationMetadata,
  buildPatientRouteContext,
  rejectProtectedKeys,
  toPatientErrorResponse,
} from '../../../../lib/routeSupport'
import { toIsoTimestamp } from '../../../../lib/commandSupport'
import { patientErrorSchema, patientTag } from '../../../openapi'
import '../../../../commands/document-links'

/**
 * Abandons an unfinished document creation.
 *
 * Marks the intent `abandoned` and drops its working title. If the document was in fact created
 * before the interruption, it stays with its owner — the spec forbids deleting a document
 * automatically, so abandoning records a decision rather than performing a cleanup. An
 * abandoned intent no longer blocks deleting the patient record.
 *
 * Only a `pending_create` link can be abandoned; an active link is unpinned instead.
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
    rejectProtectedKeys(body, translate)

    const parsed = parseScopedCommandInput(patientDocumentLinkResumeSchema, body, ctx, translate)

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result, logEntry } = await commandBus.execute<Record<string, unknown>, PatientDocumentLink>(
      'patient.document_links.abandon',
      { input: { ...parsed, id: params.id }, ctx },
    )

    const response = NextResponse.json(
      {
        ok: true as const,
        linkId: String(result.id),
        state: result.state,
        updatedAt: toIsoTimestamp(result.updatedAt),
      },
      { status: 200 },
    )
    return attachOperationMetadata(response, logEntry, 'patient.patient_document_link')
  } catch (err) {
    return toPatientErrorResponse(err, translateFn, 'documentLinks.abandon')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Abandon an unfinished document creation',
  methods: {
    POST: {
      summary: 'Abandon an unfinished document creation',
      description:
        'Marks a `pending_create` link as abandoned and clears its working title. Any document that was already created stays with its owner and is never deleted automatically. Only a pending intent can be abandoned — an active link is unpinned with DELETE instead. Requires `expectedUpdatedAt`.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientDocumentLinkResumeSchema },
      responses: [
        {
          status: 200,
          description: 'The intent was abandoned.',
          schema: z.object({
            ok: z.literal(true),
            linkId: z.string().uuid(),
            state: z.literal('abandoned'),
            updatedAt: z.string().nullable(),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid payload or a missing version token', schema: patientErrorSchema },
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'patient.clinical.manage is not granted', schema: patientErrorSchema },
        { status: 404, description: 'The link is not visible in this scope', schema: patientErrorSchema },
        { status: 409, description: 'Stale version, or the link is not an unfinished intent', schema: patientErrorSchema },
      ],
    },
  },
}
