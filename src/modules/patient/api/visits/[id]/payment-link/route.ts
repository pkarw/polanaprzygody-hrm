import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { patientVisitPaymentLinkRequestSchema } from '../../../../data/validators'
import { runVisitActionRoute } from '../../../../lib/visitActionRoute'
import {
  patientTag,
  patientVisitPaymentActionResultSchema,
  patientWriteErrors,
} from '../../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['patient.visits.manage'] },
}

export async function POST(
  req: Request,
  routeCtx: { params: { id: string } | Promise<{ id: string }> },
): Promise<Response> {
  return await runVisitActionRoute(req, routeCtx, {
    schema: patientVisitPaymentLinkRequestSchema,
    commandId: () => 'patient.visits.ensurePaymentLink',
    commandInput: (payload, id) => ({ id, expectedUpdatedAt: payload.expectedUpdatedAt }),
    errorContext: 'visits.payment-link',
    paymentResult: true,
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Create or reuse a visit payment link',
  methods: {
    POST: {
      summary: 'Create, regenerate, or return the active payment link',
      description:
        'Uses the current visit version and trusted scope to return one active checkout link. Inactive links are replaced and concurrent retries converge on the same scoped link.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientVisitPaymentLinkRequestSchema },
      responses: [{
        status: 200,
        description: 'The visit lifecycle state and active payment link.',
        schema: patientVisitPaymentActionResultSchema,
      }],
      errors: [...patientWriteErrors],
    },
  },
}
