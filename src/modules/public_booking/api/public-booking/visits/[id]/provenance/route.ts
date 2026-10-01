import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { buildPatientRouteContext, toPatientErrorResponse } from '../../../../../../patient/lib/routeSupport'
import { BookingIntake } from '../../../../../data/entities'
import { bookingConsentProofSchema } from '../../../../../data/validators'
import { publicBookingProvenanceSchema, publicBookingTag } from '../../../../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['patient.visits.view'] },
}

export async function GET(
  request: Request,
  routeCtx: { params: { id: string } | Promise<{ id: string }> },
): Promise<Response> {
  let translate: (key: string, fallback?: string) => string = (_key, fallback) => fallback ?? ''
  try {
    const resolved = await buildPatientRouteContext(request)
    translate = resolved.translate
    const { id } = await Promise.resolve(routeCtx.params)
    const visitId = z.string().uuid().parse(id)
    const tenantId = resolved.ctx.auth?.tenantId ?? null
    const organizationId = resolved.ctx.selectedOrganizationId ?? resolved.ctx.auth?.orgId ?? null
    if (!tenantId || !organizationId) {
      throw new CrudHttpError(400, { error: 'A tenant and organization scope are required' })
    }
    const em = (resolved.ctx.container.resolve('em') as EntityManager).fork()
    const intake = await findOneWithDecryption(em, BookingIntake, {
      visitId,
      tenantId,
      organizationId,
      deletedAt: null,
    } as FilterQuery<BookingIntake>, undefined, { tenantId, organizationId })
    if (!intake) return NextResponse.json({ onlineBooking: null })
    const consents = bookingConsentProofSchema.parse(JSON.parse(intake.consentProof))
    return NextResponse.json({
      onlineBooking: {
        submittedAt: intake.submittedAt.toISOString(),
        termsAcceptedAt: consents.terms.acceptedAt,
        privacyPolicyAcceptedAt: consents.privacyPolicy.acceptedAt,
        confirmationEmailSentAt: intake.confirmationEmailSentAt?.toISOString() ?? null,
      },
    })
  } catch (error) {
    return toPatientErrorResponse(error, translate, 'visits.onlineBookingProvenance')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: publicBookingTag,
  summary: 'Read online-booking provenance for a visit',
  methods: {
    GET: {
      summary: 'Return consent and submission markers when the visit originated online',
      description: 'Requires patient.visits.view. Staff-created visits return a null marker.',
      tags: [publicBookingTag],
      responses: [{ status: 200, description: 'Scoped provenance or null.', schema: publicBookingProvenanceSchema }],
      errors: [
        { status: 400, description: 'Invalid visit or scope.' },
        { status: 401, description: 'Authentication required.' },
        { status: 403, description: 'Visit access is not granted.' },
        { status: 500, description: 'Provenance could not be read.' },
      ],
    },
  },
}
