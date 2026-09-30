import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  buildPatientRouteContext,
  toPatientErrorResponse,
} from '../../../../lib/routeSupport'
import { assertClinicalFilesAvailable } from '../../../../lib/clinicalFileGate'
import { patientErrorSchema, patientTag } from '../../../openapi'

/**
 * Serves the bytes of a linked clinical file.
 *
 * **Deliberately refused.** This is the endpoint it would be most tempting to ship: a
 * patient-scoped download that checks `patient.clinical.view`, verifies the link and its parent,
 * and streams through `readScoped` with `no-store`. It would be correct in isolation and
 * worthless in practice, because the same bytes remain available from
 * `/api/attachments/file/<id>` to anyone in the organization. The spec names that shape exactly:
 * a new protected endpoint that leaves the old URL open is a pretend fix, not a fix.
 *
 * Adding it would also actively mislead — an operator who sees a working, feature-gated download
 * has every reason to conclude the file is protected.
 *
 * So it answers 503 until the host authorizes owner and partition access across download,
 * image/preview, library list/detail, transfer/reassignment, delete and export. See
 * `lib/clinicalFileGate.ts` for what was verified and how to enable it.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['patient.clinical.view'] },
}

export async function GET(req: Request, _routeCtx: { params: { id: string } | Promise<{ id: string }> }) {
  let translateFn: (key: string, fallback?: string) => string = (_key, fallback) => fallback ?? ''
  try {
    const { translate } = await buildPatientRouteContext(req)
    translateFn = translate
    assertClinicalFilesAvailable()
    // Unreachable while the gate is closed. With a supported host: resolve the link in scope,
    // confirm its patient (and diagnosis) are live, then `attachmentService.readScoped` with
    // `Cache-Control: no-store` and a safe content disposition.
    return NextResponse.json(
      {
        error: translate(
          'patient.files.notImplemented',
          'Clinical file download is not available on this installation.',
        ),
        code: 'not_implemented',
      },
      { status: 503 },
    )
  } catch (err) {
    return toPatientErrorResponse(err, translateFn, 'attachmentLinks.file')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Download a clinical file (unavailable on this installation)',
  methods: {
    GET: {
      summary: 'Download a clinical file (unavailable on this installation)',
      description:
        'Reserved for the scope-, link- and feature-checked byte stream. Returns 503 with `code: clinical_file_protection_unavailable` on this installation. Shipping a protected endpoint here while `/api/attachments/file/<id>` still serves the same bytes to any signed-in user of the organization would be a pretend fix and would mislead operators into believing the file is protected. See `lib/clinicalFileGate.ts`.',
      tags: [patientTag],
      responses: [],
      errors: [
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'patient.clinical.view is not granted', schema: patientErrorSchema },
        { status: 404, description: 'The link is not visible in this scope', schema: patientErrorSchema },
        {
          status: 503,
          description: 'Clinical file protection (SEC-ATT) is unavailable on this host version',
          schema: patientErrorSchema.extend({ code: z.string(), capability: z.string().optional() }),
        },
      ],
    },
  },
}
