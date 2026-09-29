import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { parseScopedCommandInput } from '@open-mercato/shared/lib/api/scoped'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PatientDocumentLink } from '../../../data/entities'
import { patientDocumentLinkNewSchema } from '../../../data/validators'
import {
  attachOperationMetadata,
  buildPatientRouteContext,
  rejectProtectedKeys,
  toPatientErrorResponse,
} from '../../../lib/routeSupport'
import { toIsoTimestamp } from '../../../lib/commandSupport'
import { patientErrorSchema, patientTag } from '../../openapi'
import '../../../commands/document-links'

/**
 * Creates a NEW document from the patient card and links it.
 *
 * Two statuses, and the difference matters to the UI:
 *
 * - **201** — the document exists and the link is `linked`. The client opens the native editor.
 * - **202** — the intent is committed but the document is not confirmed yet, so the link is
 *   still `pending_create`. The client shows "finish this assignment" rather than opening an
 *   editor for a document that may not be there.
 *
 * Reporting 202 instead of a 500 is the point of the whole design: an interruption between the
 * intent and the document leaves something resumable, and resuming reuses the same ids so a
 * second document can never appear.
 *
 * `documents.create` is required on top of `patient.clinical.manage`, because the actual
 * creation runs through the documents module's own command and its own feature check.
 */
export const metadata = {
  POST: {
    requireAuth: true,
    requireFeatures: ['patient.clinical.manage', 'documents.create'],
  },
}

export async function POST(req: Request) {
  let translateFn: (key: string, fallback?: string) => string = (_key, fallback) => fallback ?? ''
  try {
    const { ctx, translate } = await buildPatientRouteContext(req)
    translateFn = translate
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    // `state` and `contentId` are on the protected list: both are decided by the intent, and a
    // client-supplied `contentId` would let a caller point the new document's content at a row
    // it chose.
    rejectProtectedKeys(body, translate)

    const parsed = parseScopedCommandInput(patientDocumentLinkNewSchema, body, ctx, translate)

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result, logEntry } = await commandBus.execute<Record<string, unknown>, PatientDocumentLink>(
      'patient.document_links.create_document',
      { input: parsed, ctx },
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
      { status: isPending ? 202 : 201 },
    )
    return attachOperationMetadata(response, logEntry, 'patient.patient_document_link')
  } catch (err) {
    return toPatientErrorResponse(err, translateFn, 'documentLinks.new')
  }
}

const newDocumentLinkResponseSchema = z.object({
  ok: z.literal(true),
  linkId: z.string().uuid(),
  documentId: z.string().uuid(),
  state: z.enum(['pending_create', 'linked']),
  updatedAt: z.string().nullable(),
})

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Create a new document for a patient',
  methods: {
    POST: {
      summary: 'Create a new document for a patient',
      description:
        'Writes a creation intent, asks the documents module to create the document with the ids the intent fixed, then activates the link. Returns 201 when the document is confirmed and 202 with a `pending_create` link when it is not — the client then offers to finish the assignment. Because the ids are fixed by the intent, a retry can never create a second document. Requires `clientRequestId`.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientDocumentLinkNewSchema },
      responses: [
        { status: 201, description: 'The document was created and linked.', schema: newDocumentLinkResponseSchema },
        {
          status: 202,
          description: 'The intent is recorded; the document is not confirmed yet and the link is resumable.',
          schema: newDocumentLinkResponseSchema,
        },
      ],
      errors: [
        { status: 400, description: 'Invalid payload, or a server-owned field was supplied', schema: patientErrorSchema },
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'patient.clinical.manage or documents.create is not granted', schema: patientErrorSchema },
        { status: 404, description: 'The patient is not visible in this scope', schema: patientErrorSchema },
        { status: 409, description: 'The record is archived, or the request id was reused with different content', schema: patientErrorSchema },
        { status: 503, description: 'Encryption for patient data is unavailable', schema: patientErrorSchema },
      ],
    },
  },
}
