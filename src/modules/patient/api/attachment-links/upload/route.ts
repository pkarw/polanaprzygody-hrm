import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  buildPatientRouteContext,
  toPatientErrorResponse,
} from '../../../lib/routeSupport'
import { assertClinicalFilesAvailable } from '../../../lib/clinicalFileGate'
import { patientErrorSchema, patientTag } from '../../openapi'

/**
 * Uploads a clinical file for a patient or a diagnosis.
 *
 * **Not implemented, and refused rather than approximated.** The upload itself is the easy half:
 * `AttachmentService.readUploadForm` + `createScoped(persistLink)` into a private
 * `patient-clinical` partition is a well-defined call. The half that cannot be built here is the
 * one that matters — nothing stops the resulting bytes being served to any signed-in user of the
 * organization through `/api/attachments/file/<id>`, because the installed host authorizes that
 * route by scope alone.
 *
 * Shipping the upload anyway would produce exactly the outcome the spec forbids: a private
 * partition, a clinical-feature-gated link, an operator who reasonably believes the file is
 * protected, and an unprotected URL serving it. So the endpoint exists — so the surface is
 * discoverable and the reason is documented where someone looks for it — and answers 503 with the
 * capability name.
 *
 * Full rationale and the verification behind it: `lib/clinicalFileGate.ts`.
 */
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['patient.clinical.manage'] },
}

export async function POST(req: Request) {
  let translateFn: (key: string, fallback?: string) => string = (_key, fallback) => fallback ?? ''
  try {
    const { translate } = await buildPatientRouteContext(req)
    translateFn = translate
    // Before reading the multipart body: refusing after buffering a large clinical file would
    // spend the transfer and the memory to reach the same answer.
    assertClinicalFilesAvailable()
    // Unreachable while the gate is closed. When a supported host arrives, the upload lands here:
    // attachmentService.readUploadForm, then createScoped with persistLink writing the
    // patient_attachment_links row in the same operation, into the private `patient-clinical`
    // partition with a neutral storage identifier.
    return NextResponse.json(
      {
        error: translate(
          'patient.files.notImplemented',
          'Clinical file upload is not available on this installation.',
        ),
        code: 'not_implemented',
      },
      { status: 503 },
    )
  } catch (err) {
    return toPatientErrorResponse(err, translateFn, 'attachmentLinks.upload')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: patientTag,
  summary: 'Upload a clinical file (unavailable on this installation)',
  methods: {
    POST: {
      summary: 'Upload a clinical file (unavailable on this installation)',
      description:
        'Reserved for the bounded multipart upload that writes a private `patient-clinical` attachment and its patient link in one operation. Returns 503 with `code: clinical_file_protection_unavailable` on this installation: the attachments module authorizes downloads by tenant and organization scope only, so the uploaded bytes would be readable by any signed-in user of the organization who knows the attachment id. See `lib/clinicalFileGate.ts`.',
      tags: [patientTag],
      responses: [],
      errors: [
        { status: 401, description: 'Authentication required', schema: patientErrorSchema },
        { status: 403, description: 'patient.clinical.manage is not granted', schema: patientErrorSchema },
        {
          status: 503,
          description: 'Clinical file protection (SEC-ATT) is unavailable on this host version',
          schema: patientErrorSchema.extend({ code: z.string(), capability: z.string().optional() }),
        },
      ],
    },
  },
}
