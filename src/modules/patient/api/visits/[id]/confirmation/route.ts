import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { patientVisitConfirmationRequestSchema } from '../../../../data/validators'
import { runVisitActionRoute } from '../../../../lib/visitActionRoute'
import {
  patientTag,
  patientVisitLifecycleResultSchema,
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
    schema: patientVisitConfirmationRequestSchema,
    commandId: (payload) => payload.confirmed ? 'patient.visits.confirm' : 'patient.visits.unconfirm',
    commandInput: (payload, id) => ({ id, expectedUpdatedAt: payload.expectedUpdatedAt }),
    errorContext: 'visits.confirmation',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Change visit confirmation',
  methods: {
    POST: {
      summary: 'Confirm or unconfirm a planned visit',
      description:
        'Sets or clears server-owned confirmation actor/time fields for a planned visit. Requires `patient.visits.manage` and the current `expectedUpdatedAt` version.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientVisitConfirmationRequestSchema },
      responses: [{
        status: 200,
        description: 'The current lifecycle state and new version.',
        schema: patientVisitLifecycleResultSchema,
      }],
      errors: [...patientWriteErrors],
    },
  },
}
