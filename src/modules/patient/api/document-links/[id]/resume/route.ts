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
 * Finishes an interrupted document creation.
 *
 * Idempotent by construction: the intent already fixed the document and content ids, so this
 * either finds the document that was created before the interruption and activates the link, or
 * creates it with those same ids. It can never produce a second document, which is what the
 * whole two-transaction design exists to guarantee.
 *
 * When the document is found rather than created, the caller's access to it is re-verified
 * before the link is activated — resuming must not become a way to attach a document the caller
 * could not otherwise read.
 */
export const metadata = {
  POST: {
    requireAuth: true,
    requireFeatures: ['patient.clinical.manage', 'documents.create'],
  },
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
      'patient.document_links.resume',
      { input: { ...parsed, id: params.id }, ctx },
    )

    const isPending = result.state === 'pending_create'
    const response = NextResponse.json(
      {
        ok: true as const,
        linkId: String(result.id),
        documentId: String(result.documentId),
        state: result.state,
        updatedAt: toIsoTimestamp(result.updatedAt),
      },
      { status: isPending ? 202 : 200 },
    )
    return attachOperationMetadata(response, logEntry, 'patient.patient_document_link')
  } catch (err) {
    return toPatientErrorResponse(err, translateFn, 'documentLinks.resume')
  }
}

const resumeResponseSchema = z.object({
  ok: z.literal(true),
  linkId: z.string().uuid(),
  documentId: z.string().uuid(),
  state: z.enum(['pending_create', 'linked']),
  updatedAt: z.string().nullable(),
})

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Resume an interrupted document creation',
  methods: {
    POST: {
      summary: 'Resume an interrupted document creation',
      description:
        'Activates a `pending_create` link, creating the document only if it is absent. Reuses the ids the intent fixed, so it can never produce a second document. When the document already exists, the caller\'s access to it is re-verified before activation. Requires `expectedUpdatedAt`.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientDocumentLinkResumeSchema },
      responses: [
        { status: 200, description: 'The link is now active.', schema: resumeResponseSchema },
        { status: 202, description: 'Still pending; the document is not confirmed yet.', schema: resumeResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Invalid payload or a missing version token', schema: patientErrorSchema },
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'patient.clinical.manage or documents.create is not granted', schema: patientErrorSchema },
        { status: 404, description: 'The link or its document is not visible in this scope', schema: patientErrorSchema },
        { status: 409, description: 'Stale version, or the intent was abandoned', schema: patientErrorSchema },
      ],
    },
  },
}
