import { NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { publicBookingAvailabilityQuerySchema } from '../../../../data/validators'
import { findPublicBookingAvailability } from '../../../../lib/publicDiscovery'
import { buildPublicBookingReadContext, publicBookingErrorResponse } from '../../../../lib/routeSupport'
import { publicBookingAvailabilitySchema, publicBookingErrorSchema, publicBookingTag } from '../../../openapi'

export const metadata = { GET: { requireAuth: false } }

export async function GET(request: Request): Promise<Response> {
  try {
    const parsed = publicBookingAvailabilityQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    )
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid availability parameters' }, { status: 422 })
    }
    const context = await buildPublicBookingReadContext(request)
    if (context.rateLimitResponse) return context.rateLimitResponse
    const result = await findPublicBookingAvailability({
      ...context,
      ...parsed.data,
      from: new Date(parsed.data.from),
      to: new Date(parsed.data.to),
    })
    return NextResponse.json(result)
  } catch (error) {
    return publicBookingErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: publicBookingTag,
  summary: 'Public booking availability',
  methods: {
    GET: {
      summary: 'List zero-conflict therapist and room slots',
      description: 'Room selection remains server-side. Planner degradation returns an empty slot list with degraded=true.',
      tags: [publicBookingTag],
      query: publicBookingAvailabilityQuerySchema,
      responses: [{ status: 200, description: 'Available slots or a fail-closed degraded result.', schema: publicBookingAvailabilitySchema }],
      errors: [
        { status: 404, description: 'Bookable service or therapist not found.', schema: publicBookingErrorSchema },
        { status: 422, description: 'Invalid or out-of-bounds range.', schema: publicBookingErrorSchema },
        { status: 429, description: 'Read rate limit exceeded.', schema: publicBookingErrorSchema },
        { status: 503, description: 'Scoped service identity unavailable.', schema: publicBookingErrorSchema },
      ],
    },
  },
}
