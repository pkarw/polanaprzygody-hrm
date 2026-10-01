import { NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { publicBookingErrorSchema, publicBookingTag, publicBookingTherapistSchema } from '../../../../../openapi'
import { listPublicBookingTherapists } from '../../../../../../lib/publicDiscovery'
import { buildPublicBookingReadContext, publicBookingErrorResponse } from '../../../../../../lib/routeSupport'

export const metadata = { path: '/public/booking/services/[id]/therapists', GET: { requireAuth: false } }

type HandlerContext = { params?: Record<string, string> }

export async function GET(request: Request, handler?: HandlerContext): Promise<Response> {
  try {
    const productId = handler?.params?.id ?? ''
    const context = await buildPublicBookingReadContext(request)
    if (context.rateLimitResponse) return context.rateLimitResponse
    const items = await listPublicBookingTherapists({ ...context, productId })
    return NextResponse.json(items)
  } catch (error) {
    return publicBookingErrorResponse(error)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: publicBookingTag,
  summary: 'Public therapists for a service',
  methods: {
    GET: {
      summary: 'List active therapists assigned to a bookable service',
      tags: [publicBookingTag],
      responses: [{ status: 200, description: 'Assigned public therapist profiles.', schema: publicBookingTherapistSchema.array() }],
      errors: [
        { status: 404, description: 'Bookable service not found.', schema: publicBookingErrorSchema },
        { status: 429, description: 'Read rate limit exceeded.', schema: publicBookingErrorSchema },
        { status: 503, description: 'Scoped service identity unavailable.', schema: publicBookingErrorSchema },
      ],
    },
  },
}
