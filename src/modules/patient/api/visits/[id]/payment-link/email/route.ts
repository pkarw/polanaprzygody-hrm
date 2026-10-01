import { randomUUID } from 'node:crypto'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { patientVisitPaymentLinkEmailRequestSchema } from '../../../../../data/validators'
import { runVisitActionRoute } from '../../../../../lib/visitActionRoute'
import {
  patientTag,
  patientVisitPaymentActionResultSchema,
  patientWriteErrors,
} from '../../../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['patient.visits.manage'] },
}

export async function POST(
  req: Request,
  routeCtx: { params: { id: string } | Promise<{ id: string }> },
): Promise<Response> {
  return await runVisitActionRoute(req, routeCtx, {
    schema: patientVisitPaymentLinkEmailRequestSchema,
    commandId: () => 'patient.visits.sendPaymentLinkEmail',
    commandInput: (payload, id, request) => ({
      id,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      emailOperationKey: request.headers.get('idempotency-key')?.trim() || randomUUID(),
    }),
    errorContext: 'visits.payment-link.email',
    paymentResult: true,
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Send a visit payment link email',
  methods: {
    POST: {
      summary: 'Queue the current payment link for email delivery',
      description:
        'Creates or reuses the scoped active link and queues its opaque URL for delivery to the authorized patient contact. Requires the current visit version. An optional Idempotency-Key header reuses the same delivery operation on HTTP retry; use a new key for an intentional resend.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientVisitPaymentLinkEmailRequestSchema },
      responses: [{
        status: 200,
        description: 'The current payment link and email queue outcome.',
        schema: patientVisitPaymentActionResultSchema,
      }],
      errors: [...patientWriteErrors],
    },
  },
}
