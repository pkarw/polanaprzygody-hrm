import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

/**
 * The SEC-ATT gate: whether clinical files may be stored and served at all.
 *
 * ## What is missing, and how it was verified
 *
 * The PAT spec makes phase PAT-3 conditional on the host supplying an owner-authorization
 * contract that runs *before* attachment bytes or metadata are read. Verified against the
 * installed `@open-mercato/core` (version pinned in `package.json`):
 *
 * - `attachments/lib/access.ts` → `checkAttachmentAccess(auth, attachment, partition)` returns
 *   `{ ok: true }` for **any authenticated user in the same tenant and organization**
 *   (`isSameScope`). It takes no feature list and no parent record, so it cannot express
 *   "the caller holds `patient.clinical.view` and the link's patient is still live".
 * - `attachments/api/file/[id]/route.ts` calls that function directly, and its own route
 *   metadata is `GET: { requireAuth: false }`. There is no resolver registry, no DI token and
 *   no interceptor between the request and the bytes.
 * - `attachments/lib/target-access-service.ts` → `AttachmentTargetAccessService` looks close,
 *   but it is *caller-invoked*: a module asks it whether a user may reach an attachment given
 *   some targets. The download, image, library and transfer routes do not consult it, so
 *   implementing it would protect only the paths this module controls and leave the host's own
 *   URLs open — which the spec names explicitly as a pretend fix.
 *
 * Consequence: **any signed-in user of the organization who knows an attachment id can read a
 * private clinical file.** That is a host gap, not something this module can close.
 *
 * ## Why this file exists instead of a workaround
 *
 * The spec forbids three tempting shortcuts, and this gate is what keeps the module honest
 * about all three:
 *
 * 1. **Inventing the contract's name.** `patient/api/interceptors.ts` is not a proven solution,
 *    because `src/app/api/[...slug]/route.ts` dispatches a custom handler without a general API
 *    interceptor. Declaring one would look like protection and provide none.
 * 2. **Editing `node_modules`.** Not permitted, and it would be reverted by the next install.
 * 3. **Hardening only the new endpoint.** A patient-scoped download route that checks the
 *    clinical feature is worth nothing while `/api/attachments/file/<id>` serves the same bytes
 *    to anyone in the organization.
 *
 * So the module ships the data model and the surfaces, and refuses the operation with a
 * structured 503 that names the missing capability. A feature that visibly does not work is
 * safe; one that looks protected and is not is how clinical data leaks.
 *
 * ## Opening the gate
 *
 * `OM_PATIENT_CLINICAL_FILES_ENABLED` is the single documented switch, default **off**. It is
 * deliberately an explicit deployment assertion rather than a runtime probe: whether the host
 * enforces owner authorization cannot be detected from inside this module — the behaviour of a
 * function it does not call, on routes it does not own, is not introspectable — so a probe
 * would only ever guess. An operator may set it once their host version supplies the contract
 * across download, image/preview, library list/detail, transfer/reassignment, delete and export.
 * `__tests__/clinicalFileGate.test.ts` pins the host behaviour that currently justifies the
 * default, so a host upgrade that fixes it makes that test fail and prompts a re-evaluation
 * rather than leaving the gate shut forever.
 */

export type ClinicalFileGateState =
  | { available: true }
  | { available: false; reason: string; code: string }

export const CLINICAL_FILES_FLAG = 'OM_PATIENT_CLINICAL_FILES_ENABLED' as const

/** The stable code clients branch on, so the UI can explain the state rather than just fail. */
export const CLINICAL_FILES_UNAVAILABLE_CODE = 'clinical_file_protection_unavailable' as const

export function resolveClinicalFileGate(
  env: Record<string, string | undefined> = process.env,
): ClinicalFileGateState {
  const enabled = parseBooleanWithDefault(env[CLINICAL_FILES_FLAG], false)
  if (enabled) return { available: true }
  return {
    available: false,
    code: CLINICAL_FILES_UNAVAILABLE_CODE,
    reason:
      'Clinical file storage is disabled because the installed attachments module authorizes ' +
      'downloads by tenant and organization scope only, without the patient clinical feature or ' +
      'the parent record. Enabling it would let any signed-in user of the organization read a ' +
      "patient's files by id.",
  }
}

/**
 * Refuses the operation with a 503 while the gate is closed.
 *
 * 503 rather than 403 or 501 on purpose: the caller may well be fully authorized, and the
 * feature is not permanently absent — a supported host version restores it. 503 is the spec's
 * own code for "a required service or protection is unavailable", and it tells an operator to
 * escalate rather than to ask for a permission they already hold.
 */
export function assertClinicalFilesAvailable(
  env: Record<string, string | undefined> = process.env,
): void {
  const gate = resolveClinicalFileGate(env)
  if (gate.available) return
  throw new CrudHttpError(503, {
    error: gate.reason,
    code: gate.code,
    capability: 'SEC-ATT',
  })
}
