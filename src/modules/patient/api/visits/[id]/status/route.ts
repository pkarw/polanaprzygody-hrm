import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { patientVisitStatusRequestSchema } from '../../../../data/validators'
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
    schema: patientVisitStatusRequestSchema,
    commandId: () => 'patient.visits.transition',
    commandInput: (payload, id) => ({ id, ...payload }),
    errorContext: 'visits.status',
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Change visit status',
  methods: {
    POST: {
      summary: 'Complete, cancel, mark no-show, or reopen a visit',
      description:
        'Closes a planned visit or reopens a closed visit. Cancel, no-show, and reopen require a reason; reopen additionally requires `patient.visits.correct` at command level and resets confirmation while preserving settlement.',
      tags: [patientTag],
      requestBody: { contentType: 'application/json', schema: patientVisitStatusRequestSchema },
      responses: [{
        status: 200,
        description: 'The current lifecycle state and new version.',
        schema: patientVisitLifecycleResultSchema,
      }],
      errors: [...patientWriteErrors],
    },
  },
}
