import { NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  publicBookingErrorSchema,
  publicBookingRequestBodySchema,
  publicBookingRequestSuccessSchema,
  publicBookingTag,
} from '../../../openapi'
import { publicBookingRequestSchema } from '../../../../data/validators'
import { enforcePublicBookingSubmitRateLimit } from '../../../../lib/publicRateLimit'
import {
  assertPublicBookingRequestSize,
  buildPublicBookingSubmissionContext,
  publicBookingSubmissionError,
  submitPublicBookingRequest,
  validatePublicBookingOrigin,
} from '../../../../lib/publicSubmission'

export const metadata = { POST: { requireAuth: false } }

export async function POST(request: Request): Promise<Response> {
  try {
    validatePublicBookingOrigin(request)
    assertPublicBookingRequestSize(request)
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      return NextResponse.json({ error: 'Idempotency-Key must be between 16 and 128 characters' }, { status: 400 })
    }
    const container = await createRequestContainer()
    const rateLimitResponse = await enforcePublicBookingSubmitRateLimit(request, container)
    if (rateLimitResponse) return rateLimitResponse
    const body = await readJsonSafe<Record<string, unknown>>(request, {})
    const parsed = publicBookingRequestSchema.parse(body)
    const context = await buildPublicBookingSubmissionContext(request, container)
    await submitPublicBookingRequest(context, parsed, idempotencyKey)
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error) {
    const mapped = publicBookingSubmissionError(error)
    return NextResponse.json(mapped.body, { status: mapped.status })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: publicBookingTag,
  summary: 'Submit a public visit request',
  methods: {
    POST: {
      summary: 'Create an idempotent visit request from a verified free slot',
      tags: [publicBookingTag],
      requestBody: { contentType: 'application/json', schema: publicBookingRequestBodySchema },
      responses: [{ status: 201, description: 'The booking request was accepted.', schema: publicBookingRequestSuccessSchema }],
      errors: [
        { status: 400, description: 'Malformed request, missing idempotency, or missing consent.', schema: publicBookingErrorSchema },
        { status: 403, description: 'Untrusted host or origin.', schema: publicBookingErrorSchema },
        { status: 404, description: 'Inactive service or therapist.', schema: publicBookingErrorSchema },
        { status: 409, description: 'Idempotency mismatch or slot conflict.', schema: publicBookingErrorSchema },
        { status: 422, description: 'Lead-time, range, or scheduling validation failed.', schema: publicBookingErrorSchema },
        { status: 429, description: 'Write rate limit exceeded.', schema: publicBookingErrorSchema },
        { status: 503, description: 'Scope, limiter, encryption, planner, or compensation unavailable.', schema: publicBookingErrorSchema },
      ],
    },
  },
}
