import { NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { publicBookingErrorSchema, publicBookingServiceSchema, publicBookingTag } from '../../../openapi'
import { listPublicBookingServices } from '../../../../lib/publicDiscovery'
import { buildPublicBookingReadContext, publicBookingErrorResponse } from '../../../../lib/routeSupport'

export const metadata = { path: '/public/booking/services', GET: { requireAuth: false } }

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await buildPublicBookingReadContext(request)
    if (context.rateLimitResponse) return context.rateLimitResponse
    const items = await listPublicBookingServices(context)
    return NextResponse.json(items)
  } catch (error) {
    return publicBookingErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: publicBookingTag,
  summary: 'Publicly bookable services',
  methods: {
    GET: {
      summary: 'List publicly bookable services and current prices',
      tags: [publicBookingTag],
      responses: [{ status: 200, description: 'Complete bookable services.', schema: publicBookingServiceSchema.array() }],
      errors: [
        { status: 429, description: 'Read rate limit exceeded.', schema: publicBookingErrorSchema },
        { status: 503, description: 'Scoped service identity or catalogue unavailable.', schema: publicBookingErrorSchema },
      ],
    },
  },
}
