import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { patientVisitSettlementRequestSchema } from '../../../../data/validators'
import { runVisitActionRoute } from '../../../../lib/visitActionRoute'
import {
  patientTag,
  patientVisitLifecycleResultSchema,
  patientWriteErrors,
} from '../../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['patient.visits.settle'] },
}

export async function POST(
  req: Request,
  routeCtx: { params: { id: string } | Promise<{ id: string }> },
): Promise<Response> {
  return await runVisitActionRoute(req, routeCtx, {
    schema: patientVisitSettlementRequestSchema,
    commandId: (payload) => payload.isSettled ? 'patient.visits.settle' : 'patient.visits.unsettle',
    commandInput: (payload, id) => ({
      id,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    }),
    errorContext: 'visits.settlement',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Change manual visit settlement',
  methods: {
    POST: {
      summary: 'Set or remove manual visit settlement',
      description:
        'Changes the independent manual settlement marker in any visit status. Removing settlement requires a reason. This action never creates a payment, invoice, price, or resource reservation.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientVisitSettlementRequestSchema },
      responses: [{
        status: 200,
        description: 'The current lifecycle state and new version.',
        schema: patientVisitLifecycleResultSchema,
      }],
      errors: [...patientWriteErrors],
    },
  },
}
