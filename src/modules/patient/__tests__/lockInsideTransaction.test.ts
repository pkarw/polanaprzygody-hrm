import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'

/**
 * Regression oracle for the bug that broke every write in this module except `patients.create`.
 *
 * `lockPatient` issues a `SELECT … FOR UPDATE` via MikroORM's `LockMode.PESSIMISTIC_WRITE`, and
 * MikroORM refuses that outside an open transaction:
 *
 *     ValidationError: An open transaction is required for this operation
 *       at checkLockRequirements → findOne → lockPatient
 *
 * Every command originally locked BEFORE calling `runCrudCommandWrite`, which is what opens the
 * transaction — so update, archive, delete, and every address, contact, diagnosis, document-link
 * and file-link write failed with a 500. Only `patients.create` worked, because it is the one
 * command that never locks.
 *
 * Nothing caught it: it type-checks, it lints, and the unit suite never opens a database. It
 * surfaced only when a human clicked "save".
 *
 * The fix is positional — the lock has to be the FIRST PHASE of `runCrudCommandWrite`, which
 * receives a `phaseEm` bound to the open transaction — so the regression guard is positional too:
 * every call must pass `phaseEm`, except a small allow-list of sites that open a transaction
 * themselves and are named here individually.
 *
 * This is a source-level check on purpose. The alternative, a live database test, would be
 * stronger but cannot run in the unit suite, and a guard that only runs where Docker is available
 * is a guard that does not run.
 */

const COMMANDS_DIR = path.join(__dirname, '..', 'commands')

/**
 * Call sites that legitimately lock through the request `em` rather than a phase `em`, because
 * they open and own a transaction themselves.
 *
 * Each entry names WHY. Adding one without a real enclosing transaction re-introduces the bug, so
 * the list is deliberately small and explicit rather than a pattern.
 */
const EXPLICIT_TRANSACTION_SITES: Record<string, number> = {
  // Two `withAtomicFlush(..., { transaction: true })` blocks: the creation intent, and the
  // resume pre-check. Both must commit before the documents module's own command runs, so they
  // cannot be phases of a single `runCrudCommandWrite`.
  'document-links.ts': 2,
  // Undo has no `runCrudCommandWrite` to open a transaction for it, so it calls `em.begin()`
  // and owns the commit/rollback.
  'patients.ts': 1,
  // Create/update/delete undo each owns an explicit transaction and preserves the same
  // patient → visit lock order as the forward command.
  'visits.ts': 3,
}

function readCommandSources(): Array<{ file: string; source: string }> {
  return readdirSync(COMMANDS_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({ file, source: readFileSync(path.join(COMMANDS_DIR, file), 'utf8') }))
}

describe('patient commands take the row lock inside a transaction', () => {
  const sources = readCommandSources()

  it('finds the command files', () => {
    expect(sources.length).toBeGreaterThanOrEqual(6)
  })

  it.each(readCommandSources())(
    '$file locks through a phase EntityManager, except at declared explicit-transaction sites',
    ({ file, source }) => {
      // `lockPatient(phaseEm, …)` is the safe form: `runCrudCommandWrite` hands each phase an
      // `em` that is already inside the transaction it opened.
      const bareEmCalls = (source.match(/lockPatient\(\s*em\s*,/g) ?? []).length
      expect(bareEmCalls).toBe(EXPLICIT_TRANSACTION_SITES[file] ?? 0)
    },
  )

  it.each(readCommandSources())(
    '$file opens a transaction wherever it locks through the request EntityManager',
    ({ file, source }) => {
      if (!EXPLICIT_TRANSACTION_SITES[file]) return
      // The two supported ways to own a transaction. A file that locks on the request `em`
      // without one of these is the original bug.
      const opensTransaction =
        source.includes('transaction: true') || source.includes('await em.begin()')
      expect(opensTransaction).toBe(true)
    },
  )

  /**
   * The version check must be under the lock too.
   *
   * Comparing `expectedUpdatedAt` before taking the lock is check-then-lock: two writers read the
   * same `updated_at`, both pass, and both write. The spec requires the comparison to happen
   * after the parent row is locked, in the same transaction — so wherever a file does both, the
   * first lock must appear before the first version assertion.
   */
  it.each(readCommandSources())('$file checks the version after locking, not before', ({ source }) => {
    const firstLock = source.search(/lockPatient\(/)
    const firstVersionCheck = source.search(/assertExpectedVersion\(/)
    if (firstLock === -1 || firstVersionCheck === -1) return
    expect(firstLock).toBeLessThan(firstVersionCheck)
  })

  /**
   * The same bug class one layer down: raw SQL that escapes the transaction.
   *
   * `em.getConnection().execute(q, p)` leaves MikroORM's `ctx` undefined, and
   * `AbstractSqlConnection.execute` then falls back to `(ctx ?? this.#client)` — the pool.
   * `SqlEntityManager.execute` is the only form that forwards `getTransactionContext()`.
   *
   * That distinction is invisible for most statements but fatal for two of them:
   *   - `pg_advisory_xact_lock` on a pooled connection lives in its own implicit
   *     single-statement transaction and is released before the call returns, so it provides
   *     no mutual exclusion whatsoever — two concurrent writers both "hold" the slot lock.
   *   - a transaction-local `set_config('lock_timeout', …, true)` does not apply to another
   *     connection, so the 409 lock-wait branch becomes dead code.
   *
   * Positional guards cannot catch this: the argument is the correct `phaseEm` while the SQL
   * still leaves its transaction. The form itself has to be banned.
   */
  it.each(readCommandSources())('$file issues raw SQL through the transaction-aware em', ({ source }) => {
    expect(source).not.toMatch(/getConnection\(\)\s*\.\s*execute\(/)
  })

  it.each(readCommandSources())('$file takes advisory locks through em.execute', ({ source }) => {
    if (!source.includes('pg_advisory')) return
    expect(source).toMatch(/await\s+em\.execute\(\s*\n?\s*'select pg_advisory_xact_lock/)
  })
})
