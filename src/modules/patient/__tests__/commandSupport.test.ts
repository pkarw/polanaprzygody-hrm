import { describe, expect, it } from '@jest/globals'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import {
  assertExpectedVersion,
  assertPatientAcceptsNewEntries,
  buildPatientNumber,
  canonicalizeCreatePayload,
  createRequestDigest,
  encryptSensitiveFields,
  nextUpdatedAt,
  organizationToday,
  requireActorUserId,
  requirePatientScope,
  type PatientEncryptionService,
} from '../lib/commandSupport'
import type { Patient } from '../data/entities'

function ctxWith(partial: Partial<CommandRuntimeContext>): CommandRuntimeContext {
  return {
    container: {} as CommandRuntimeContext['container'],
    auth: null,
    organizationScope: null,
    selectedOrganizationId: null,
    organizationIds: null,
    ...partial,
  }
}

/** Reads the status off a thrown CrudHttpError, or fails the assertion helpfully. */
function statusOf(run: () => unknown): number {
  try {
    run()
  } catch (err) {
    if (err instanceof CrudHttpError) return err.status
    throw err
  }
  throw new Error('Expected the call to throw a CrudHttpError')
}

describe('requirePatientScope', () => {
  it('resolves the tenant and the selected organization from the session', () => {
    const scope = requirePatientScope(
      ctxWith({
        auth: { sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-fallback' },
        selectedOrganizationId: 'org-selected',
      }),
    )
    expect(scope).toEqual({ tenantId: 'tenant-1', organizationId: 'org-selected' })
  })

  it('falls back to the session organization when none is explicitly selected', () => {
    const scope = requirePatientScope(
      ctxWith({ auth: { sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-fallback' } }),
    )
    expect(scope.organizationId).toBe('org-fallback')
  })

  // The security-relevant half: a missing scope must be a refusal, never "everything".
  it('refuses a missing tenant', () => {
    expect(statusOf(() => requirePatientScope(ctxWith({ auth: null })))).toBe(400)
  })

  it('refuses a missing organization instead of treating it as unrestricted', () => {
    expect(
      statusOf(() =>
        requirePatientScope(ctxWith({ auth: { sub: 'user-1', tenantId: 'tenant-1', orgId: null } })),
      ),
    ).toBe(400)
  })
})

describe('requireActorUserId', () => {
  it('uses the authenticated subject', () => {
    expect(
      requireActorUserId(ctxWith({ auth: { sub: 'user-1', tenantId: 't', orgId: 'o' } })),
    ).toBe('user-1')
  })

  it('prefers the agent principal when the command runs on behalf of a human', () => {
    expect(
      requireActorUserId(
        ctxWith({
          auth: { sub: 'human-1', tenantId: 't', orgId: 'o' },
          runAs: { actorUserId: 'agent-1', onBehalfOfUserId: 'human-1', source: 'agent' },
        } as Partial<CommandRuntimeContext>),
      ),
    ).toBe('agent-1')
  })

  it('refuses when there is no actor at all', () => {
    expect(statusOf(() => requireActorUserId(ctxWith({ auth: null })))).toBe(401)
  })
})

describe('assertExpectedVersion', () => {
  const current = new Date('2026-09-29T10:00:00.000Z')

  it('accepts a matching token', () => {
    expect(() => assertExpectedVersion(current.toISOString(), current, 'patient:patient')).not.toThrow()
  })

  // The two failures mean different things to the client and must not collapse into one.
  it('answers a missing token with 400', () => {
    expect(statusOf(() => assertExpectedVersion(undefined, current, 'patient:patient'))).toBe(400)
  })

  it('answers a stale token with 409 and reports the current version', () => {
    try {
      assertExpectedVersion('2026-09-29T09:00:00.000Z', current, 'patient:patient')
      throw new Error('Expected a conflict')
    } catch (err) {
      expect(err).toBeInstanceOf(CrudHttpError)
      const error = err as CrudHttpError
      expect(error.status).toBe(409)
      expect(error.body).toMatchObject({
        code: 'version_conflict',
        currentUpdatedAt: current.toISOString(),
      })
    }
  })

  // An ISO string round-tripped through JSON can render the same instant differently.
  it('compares instants rather than strings', () => {
    expect(() => assertExpectedVersion('2026-09-29T10:00:00+00:00', current, 'patient:patient')).not.toThrow()
  })

  it('answers an unparseable token with 400 rather than treating it as a mismatch', () => {
    expect(statusOf(() => assertExpectedVersion('not-a-date', current, 'patient:patient'))).toBe(400)
  })
})

describe('nextUpdatedAt', () => {
  // updated_at IS the version token, so two writes in the same millisecond must not
  // produce the same token — a third writer holding the stale one would pass the check.
  it('advances past a previous timestamp in the same millisecond', () => {
    const previous = new Date(Date.now() + 5_000)
    expect(nextUpdatedAt(previous).getTime()).toBe(previous.getTime() + 1)
  })

  it('uses the clock when it has already moved on', () => {
    const previous = new Date(Date.now() - 5_000)
    expect(nextUpdatedAt(previous).getTime()).toBeGreaterThan(previous.getTime())
  })

  it('uses the clock when there is no previous value', () => {
    expect(nextUpdatedAt(null).getTime()).toBeGreaterThan(0)
  })
})

describe('assertPatientAcceptsNewEntries', () => {
  it('allows an active record', () => {
    expect(() => assertPatientAcceptsNewEntries({ status: 'active' } as Patient)).not.toThrow()
  })

  it('refuses an archived record with 409', () => {
    expect(statusOf(() => assertPatientAcceptsNewEntries({ status: 'archived' } as Patient))).toBe(409)
  })
})

describe('buildPatientNumber', () => {
  it('derives the handle from the record id, with no counter', () => {
    expect(buildPatientNumber('11111111-2222-3333-4444-555555555555')).toBe(
      'P-11111111-2222-3333-4444-555555555555',
    )
  })
})

describe('canonicalizeCreatePayload / createRequestDigest', () => {
  // A retry serialized by a different client must compare equal.
  it('is insensitive to key order', () => {
    expect(canonicalizeCreatePayload({ b: 1, a: 2 })).toBe(canonicalizeCreatePayload({ a: 2, b: 1 }))
  })

  it('canonicalizes nested objects and array members', () => {
    expect(canonicalizeCreatePayload({ outer: { z: 1, a: [{ y: 1, x: 2 }] } })).toBe(
      canonicalizeCreatePayload({ outer: { a: [{ x: 2, y: 1 }], z: 1 } }),
    )
  })

  // These two mean different things everywhere else in the module, so they must here too.
  it('drops undefined members but preserves null', () => {
    expect(canonicalizeCreatePayload({ a: 1, b: undefined })).toBe(canonicalizeCreatePayload({ a: 1 }))
    expect(canonicalizeCreatePayload({ a: 1, b: null })).not.toBe(canonicalizeCreatePayload({ a: 1 }))
  })

  it('preserves array order, which is meaningful', () => {
    expect(canonicalizeCreatePayload([1, 2])).not.toBe(canonicalizeCreatePayload([2, 1]))
  })

  it('produces a stable digest for equivalent payloads and a different one otherwise', () => {
    expect(createRequestDigest({ firstName: 'Anna', lastName: 'Kowalska' })).toBe(
      createRequestDigest({ lastName: 'Kowalska', firstName: 'Anna' }),
    )
    expect(createRequestDigest({ firstName: 'Anna' })).not.toBe(createRequestDigest({ firstName: 'Ania' }))
  })
})

describe('encryptSensitiveFields', () => {
  const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }

  const workingService: PatientEncryptionService = {
    encryptEntityPayload: async (_entityId, payload) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(payload)) out[key] = `enc(${String(value)})`
      return out
    },
  }

  it('encrypts non-empty strings and leaves null untouched', async () => {
    const result = await encryptSensitiveFields(
      'patient:patient',
      { firstName: 'Anna', description: null },
      scope,
      workingService,
    )
    expect(result).toEqual({ firstName: 'enc(Anna)', description: null })
  })

  it('does nothing when there is no sensitive value to protect', async () => {
    const result = await encryptSensitiveFields('patient:patient', { email: null }, scope, null)
    expect(result).toEqual({ email: null })
  })

  // Fail closed: the framework helper is a documented no-op when encryption is off, the
  // tenant has no key, or no map covers the entity. For clinical data each of those must
  // refuse the write rather than persist plaintext into an "encrypted" column.
  it('refuses the write with 503 when no encryption service is available', async () => {
    await expect(
      encryptSensitiveFields('patient:patient', { firstName: 'Anna' }, scope, null),
    ).rejects.toMatchObject({ status: 503 })
  })

  it('refuses the write with 503 when the service returns the plaintext unchanged', async () => {
    const noop: PatientEncryptionService = { encryptEntityPayload: async (_id, payload) => payload }
    await expect(
      encryptSensitiveFields('patient:patient', { firstName: 'Anna' }, scope, noop),
    ).rejects.toMatchObject({ status: 503 })
  })

  it('refuses the write with 503 when the service drops the field', async () => {
    const dropping: PatientEncryptionService = { encryptEntityPayload: async () => ({}) }
    await expect(
      encryptSensitiveFields('patient:patient', { firstName: 'Anna' }, scope, dropping),
    ).rejects.toMatchObject({ status: 503 })
  })

  /**
   * The refusal has to be actionable.
   *
   * The overwhelmingly common cause is a tenant that existed before this module was installed, so
   * its `patient:*` encryption maps were never materialized. Without the remedy on the error, an
   * operator sees only "the write was refused" and has nowhere to go; `encryption.ts` merely
   * DECLARES the maps, and the CLI is what creates them.
   */
  it('carries the entity id and the remedy on the refusal', async () => {
    const noop: PatientEncryptionService = { encryptEntityPayload: async (_id, payload) => payload }
    try {
      await encryptSensitiveFields('patient:patient_diagnosis', { title: 'x' }, scope, noop)
      throw new Error('Expected the write to be refused')
    } catch (err) {
      const error = err as CrudHttpError
      expect(error.status).toBe(503)
      const body = error.body as { entityId?: string; remedy?: string; error?: string }
      // Which map is missing — the remedy is per entity.
      expect(body.entityId).toBe('patient:patient_diagnosis')
      expect(body.remedy).toContain('seed-encryption')
      // The refusal says plainly that nothing was stored in plain text, which is the reassurance
      // an operator actually needs from a 503 on a clinical write.
      expect(body.error).toContain('plain text')
    }
  })

  it('does not name the offending field, which is itself clinical vocabulary', async () => {
    const noop: PatientEncryptionService = { encryptEntityPayload: async (_id, payload) => payload }
    try {
      await encryptSensitiveFields('patient:patient_diagnosis', { voidReason: 'x' }, scope, noop)
      throw new Error('Expected the write to be refused')
    } catch (err) {
      expect(JSON.stringify((err as CrudHttpError).body)).not.toContain('voidReason')
    }
  })
})

describe('organizationToday', () => {
  it('returns an ISO calendar date', () => {
    expect(organizationToday('Europe/Warsaw')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  // A clinician entering today's date just after local midnight must not be told it is in
  // the future, which is what a UTC comparison would do in Warsaw.
  it('reports the local day, which can differ from the UTC day', () => {
    const pacific = organizationToday('Pacific/Kiritimati')
    const hawaii = organizationToday('Pacific/Honolulu')
    expect(pacific >= hawaii).toBe(true)
  })

  it('falls back to UTC for an unknown timezone rather than throwing', () => {
    expect(organizationToday('Not/AZone')).toBe(organizationToday('UTC'))
  })

  it('falls back to UTC when the timezone is absent', () => {
    expect(organizationToday(null)).toBe(organizationToday('UTC'))
  })
})
