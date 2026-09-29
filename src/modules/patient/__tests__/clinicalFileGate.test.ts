import { describe, expect, it } from '@jest/globals'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { checkAttachmentAccess } from '@open-mercato/core/modules/attachments/lib/access'
import type { Attachment, AttachmentPartition } from '@open-mercato/core/modules/attachments/data/entities'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import {
  CLINICAL_FILES_FLAG,
  CLINICAL_FILES_UNAVAILABLE_CODE,
  assertClinicalFilesAvailable,
  resolveClinicalFileGate,
} from '../lib/clinicalFileGate'

/**
 * PAT-T09 — the host-capability probe behind the SEC-ATT gate.
 *
 * This suite has two halves, and the first is the important one.
 *
 * **Half one pins the installed host's actual behaviour.** It drives the real
 * `checkAttachmentAccess` — the function `attachments/api/file/[id]/route.ts` calls before it
 * streams bytes — with a private partition and a user who shares the attachment's tenant and
 * organization but holds no patient feature at all. It asserts that the host says `ok`. That is
 * the evidence for keeping clinical files disabled, captured as an executable assertion rather
 * than a sentence in a document.
 *
 * The assertion is therefore *inverted on purpose*: it does not assert the behaviour we want, it
 * asserts the behaviour we found. When a future host version starts refusing that call, this test
 * FAILS — which is exactly the signal to re-evaluate the gate and enable the phase, instead of the
 * gap being silently forgotten because nothing ever pointed at it again.
 *
 * **Half two pins the gate's own contract**: closed by default, opened only by the documented
 * flag, and refusing with 503 and a stable code the UI can branch on.
 */

/** Minimal Attachment shape `checkAttachmentAccess` reads. */
function attachmentIn(tenantId: string, organizationId: string): Attachment {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenantId,
    organizationId,
    partitionCode: 'patient-clinical',
  } as unknown as Attachment
}

/** A private partition — the strongest protection the host offers for clinical files. */
function privatePartition(): AttachmentPartition {
  return { code: 'patient-clinical', isPublic: false } as unknown as AttachmentPartition
}

function userIn(tenantId: string, organizationId: string): Exclude<AuthContext, null> {
  return {
    sub: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId,
    orgId: organizationId,
    // No patient features whatsoever. If the host consulted a feature list, this user would be
    // refused — the point of the assertion below is that it does not consult one.
    roles: [],
  }
}

describe('SEC-ATT: installed attachment download authorization', () => {
  const tenantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const organizationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  /**
   * The finding, as an assertion.
   *
   * A private clinical attachment is readable by a same-scope user holding no clinical feature.
   * When this flips to `ok: false`, the host has grown the contract PAT-3 waits for.
   */
  it('grants a same-scope user with no patient feature access to a PRIVATE clinical attachment', () => {
    const access = checkAttachmentAccess(
      userIn(tenantId, organizationId),
      attachmentIn(tenantId, organizationId),
      privatePartition(),
    )
    expect(access).toEqual({ ok: true })
  })

  // What the host DOES enforce, recorded so the gap is described precisely rather than as a blanket
  // "attachments are insecure".
  it('refuses a user from another organization', () => {
    const access = checkAttachmentAccess(
      userIn(tenantId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
      attachmentIn(tenantId, organizationId),
      privatePartition(),
    )
    expect(access).toEqual({ ok: false, status: 403 })
  })

  it('refuses a user from another tenant', () => {
    const access = checkAttachmentAccess(
      userIn('ffffffff-ffff-4fff-8fff-ffffffffffff', organizationId),
      attachmentIn(tenantId, organizationId),
      privatePartition(),
    )
    expect(access).toEqual({ ok: false, status: 403 })
  })

  it('refuses an anonymous caller', () => {
    const access = checkAttachmentAccess(null, attachmentIn(tenantId, organizationId), privatePartition())
    expect(access).toEqual({ ok: false, status: 401 })
  })

  /**
   * The function takes no feature list and no parent record.
   *
   * This is the structural reason the gap cannot be closed from inside this module: there is no
   * argument through which `patient.clinical.view` or the link's patient could be supplied.
   */
  it('accepts no feature list or parent record through which the patient ACL could be applied', () => {
    // auth, attachment, partition, options — four parameters, none of them a feature list.
    expect(checkAttachmentAccess.length).toBeLessThanOrEqual(4)
  })
})

describe('resolveClinicalFileGate', () => {
  // Closed by default: an installation that has never considered the question must not be storing
  // clinical files.
  it('is closed when the flag is absent', () => {
    const gate = resolveClinicalFileGate({})
    expect(gate.available).toBe(false)
    if (!gate.available) {
      expect(gate.code).toBe(CLINICAL_FILES_UNAVAILABLE_CODE)
      // The reason has to be readable by whoever hits it, not just a code.
      expect(gate.reason).toContain('tenant and organization scope')
    }
  })

  it('is closed when the flag is explicitly false', () => {
    expect(resolveClinicalFileGate({ [CLINICAL_FILES_FLAG]: 'false' }).available).toBe(false)
  })

  it('opens only on the documented flag', () => {
    expect(resolveClinicalFileGate({ [CLINICAL_FILES_FLAG]: 'true' }).available).toBe(true)
    expect(resolveClinicalFileGate({ [CLINICAL_FILES_FLAG]: '1' }).available).toBe(true)
  })

  it('does not open on an unrelated flag', () => {
    expect(resolveClinicalFileGate({ OM_PATIENT_CLINICAL_FILES: 'true' }).available).toBe(false)
  })
})

describe('assertClinicalFilesAvailable', () => {
  it('refuses with 503 and a stable code while the gate is closed', () => {
    try {
      assertClinicalFilesAvailable({})
      throw new Error('Expected the gate to refuse')
    } catch (err) {
      expect(err).toBeInstanceOf(CrudHttpError)
      const error = err as CrudHttpError
      // 503 rather than 403: the caller may be fully authorized, and the capability returns with a
      // supported host — so the operator should escalate, not request a permission they hold.
      expect(error.status).toBe(503)
      expect(error.body).toMatchObject({
        code: CLINICAL_FILES_UNAVAILABLE_CODE,
        capability: 'SEC-ATT',
      })
    }
  })

  it('permits the operation once the gate is open', () => {
    expect(() => assertClinicalFilesAvailable({ [CLINICAL_FILES_FLAG]: 'true' })).not.toThrow()
  })
})
