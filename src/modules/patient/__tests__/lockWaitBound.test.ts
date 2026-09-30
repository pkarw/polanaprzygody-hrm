import { afterEach, describe, expect, it } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import {
  isLockWaitTimeout,
  lockPatient,
  resolvePatientLockWaitTimeoutMs,
  type PatientScope,
} from '../lib/commandSupport'
import type { Patient } from '../data/entities'

/**
 * Regression oracle for the bug that made "save" hang instead of failing.
 *
 * Every patient write takes the aggregate row lock through `lockPatient`, a
 * `SELECT … FOR UPDATE`. Postgres waits for a row lock forever by default and this deployment
 * sets no global `lock_timeout`, so one holder — a concurrent save, or a transaction an
 * abandoned request left open until `idle_in_transaction_session_timeout` reaped it two
 * minutes later — made the next write to the same patient a request that never answered.
 *
 * What the clinician saw was not a conflict but the proxy in front of the app giving up:
 * "Request failed (502)" in the Add-diagnosis dialog, with nothing written and nothing to act
 * on. Reproduced by holding `SELECT … FOR UPDATE` on the patient row in psql and posting a
 * diagnosis: the request produced no response at all for as long as the lock was held.
 *
 * So the guard is on the two halves of the fix: the wait is bounded before the lock is taken,
 * and a timeout surfaces as a retryable 409 rather than a 500 or a dead request.
 */

const SCOPE: PatientScope = { tenantId: 'tenant-1', organizationId: 'org-1' }

type Call = { sql: string; params: unknown[] }

/**
 * Minimal `EntityManager` double: records the statements `lockPatient` issues, in order, so a
 * test can assert that the bound is applied BEFORE the lock rather than merely somewhere.
 */
function emDouble(findOne: () => Promise<unknown>) {
  const calls: Call[] = []
  const em = {
    execute: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return []
    },
    findOne: async () => {
      calls.push({ sql: 'FOR UPDATE', params: [] })
      return findOne()
    },
  }
  return { em: em as unknown as EntityManager, calls }
}

/** A driver error as MikroORM hands it up: the SQLSTATE sits on a wrapped cause. */
function wrappedDriverError(code: string): Error {
  const driver = Object.assign(new Error('canceling statement due to lock timeout'), { code })
  return Object.assign(new Error('query failed'), { previous: driver })
}

/** `NodeJS.ProcessEnv` carries a required `NODE_ENV`, so an override starts from the real env. */
function envWith(value?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (value === undefined) delete env.PATIENT_LOCK_WAIT_TIMEOUT_MS
  else env.PATIENT_LOCK_WAIT_TIMEOUT_MS = value
  return env
}

const originalTimeoutEnv = process.env.PATIENT_LOCK_WAIT_TIMEOUT_MS

afterEach(() => {
  if (originalTimeoutEnv === undefined) delete process.env.PATIENT_LOCK_WAIT_TIMEOUT_MS
  else process.env.PATIENT_LOCK_WAIT_TIMEOUT_MS = originalTimeoutEnv
})

describe('resolvePatientLockWaitTimeoutMs', () => {
  it('defaults to a bound rather than to the database default of waiting forever', () => {
    expect(resolvePatientLockWaitTimeoutMs(envWith())).toBe(5_000)
  })

  it('honors an explicit override', () => {
    expect(resolvePatientLockWaitTimeoutMs(envWith('250'))).toBe(250)
  })

  it('treats zero as "restore the unbounded database default"', () => {
    expect(resolvePatientLockWaitTimeoutMs(envWith('0'))).toBe(0)
  })

  it('falls back to the default for a value that is not a usable duration', () => {
    // A typo in the deployment env must not silently reinstate the unbounded wait.
    expect(resolvePatientLockWaitTimeoutMs(envWith('soon'))).toBe(5_000)
    expect(resolvePatientLockWaitTimeoutMs(envWith('-1'))).toBe(5_000)
  })
})

describe('isLockWaitTimeout', () => {
  it('finds the SQLSTATE on the error itself', () => {
    expect(isLockWaitTimeout(Object.assign(new Error('x'), { code: '55P03' }))).toBe(true)
  })

  it('finds it below a wrapper, on either link name', () => {
    expect(isLockWaitTimeout(wrappedDriverError('55P03'))).toBe(true)
    expect(
      isLockWaitTimeout(
        new Error('query failed', { cause: Object.assign(new Error('x'), { code: '55P03' }) }),
      ),
    ).toBe(true)
  })

  it('does not claim unrelated database errors', () => {
    // 40001 is a serialization failure and 57014 a statement timeout; neither is a lock wait,
    // and reporting them as a retryable conflict would hide a different fault.
    expect(isLockWaitTimeout(wrappedDriverError('40001'))).toBe(false)
    expect(isLockWaitTimeout(wrappedDriverError('57014'))).toBe(false)
    expect(isLockWaitTimeout(new Error('plain'))).toBe(false)
    expect(isLockWaitTimeout(null)).toBe(false)
  })
})

describe('lockPatient', () => {
  it('bounds the wait before taking the lock, not after', async () => {
    const patient = { id: 'patient-1' } as Patient
    const { em, calls } = emDouble(async () => patient)

    await expect(lockPatient(em, 'patient-1', SCOPE)).resolves.toBe(patient)

    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toContain('set_config')
    // The duration is a bound parameter: `SET` takes no placeholders, so building the
    // statement by concatenation would put a configuration value into SQL text.
    expect(calls[0].params).toEqual(['lock_timeout', '5000ms'])
    expect(calls[1].sql).toBe('FOR UPDATE')
  })

  it('skips the bound when it is explicitly disabled', async () => {
    process.env.PATIENT_LOCK_WAIT_TIMEOUT_MS = '0'
    const { em, calls } = emDouble(async () => ({ id: 'patient-1' }) as Patient)

    await lockPatient(em, 'patient-1', SCOPE)

    expect(calls.map((call) => call.sql)).toEqual(['FOR UPDATE'])
  })

  it('reports a lock timeout as a retryable conflict, not a server error', async () => {
    const { em } = emDouble(async () => {
      throw wrappedDriverError('55P03')
    })

    const error = await lockPatient(em, 'patient-1', SCOPE).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(CrudHttpError)
    const conflict = error as CrudHttpError
    expect(conflict.status).toBe(409)
    // The code is what a client can branch on; the status alone is shared with the
    // version-conflict and archived-record refusals.
    expect((conflict.body as { code?: string }).code).toBe('patient_locked')
  })

  it('lets an unrelated database error through unchanged', async () => {
    const underlying = wrappedDriverError('40001')
    const { em } = emDouble(async () => {
      throw underlying
    })

    await expect(lockPatient(em, 'patient-1', SCOPE)).rejects.toBe(underlying)
  })

  it('still 404s a patient that is out of scope or gone', async () => {
    const { em } = emDouble(async () => null)

    const error = await lockPatient(em, 'patient-1', SCOPE).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(CrudHttpError)
    expect((error as CrudHttpError).status).toBe(404)
  })
})
