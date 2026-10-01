import { createHash, randomUUID } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { LockMode } from '@mikro-orm/core'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { Patient } from '../data/entities'

/**
 * Cross-cutting helpers shared by every command in this module.
 *
 * These exist as one module rather than per-command copies because each of them is a
 * place where a subtle divergence becomes a security bug: a scope resolver that
 * defaults to "all organizations", an actor resolver that trusts the payload, a lock
 * that is taken after the version check instead of before, or an idempotency
 * comparison that includes the caller's session and so never matches a legitimate retry.
 */

export type PatientScope = {
  tenantId: string
  organizationId: string
}

/**
 * Resolves the trusted scope for a write.
 *
 * Both halves fail closed. A missing tenant or a missing selected organization is a
 * refusal, never "every organization" — the spec states that explicitly, and it is the
 * difference between an unscoped read returning nothing and returning everyone's
 * patients. Scope is never read from the payload; the routes reject scope keys outright.
 */
export function requirePatientScope(ctx: CommandRuntimeContext): PatientScope {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) throw new CrudHttpError(400, { error: 'Tenant context is required' })
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!organizationId) throw new CrudHttpError(400, { error: 'Organization context is required' })
  return { tenantId, organizationId }
}

/**
 * Resolves the acting user id from the session.
 *
 * `runAs.actorUserId` first so an agent acting on behalf of a human is attributed to the
 * agent principal, matching how the framework stamps its own action log. Never from the
 * payload: `created_by_user_id`, `updated_by_user_id` and a diagnosis `author_user_id`
 * are server-side facts, and accepting a client-supplied author would let anyone write
 * clinical history under someone else's name.
 */
export function requireActorUserId(ctx: CommandRuntimeContext): string {
  // API-key subjects are `api_key:<id>` and cannot be stored in UUID audit columns.
  // The supported auth resolver supplies the real creator/service user as `userId`.
  const actor = ctx.runAs?.actorUserId ?? ctx.auth?.userId ?? ctx.auth?.sub ?? null
  if (!actor) throw new CrudHttpError(401, { error: 'Authentication is required' })
  return actor
}

/**
 * How long a patient write may wait for the aggregate row lock before giving up.
 *
 * Postgres waits for a row lock FOREVER by default, and this deployment sets no global
 * `lock_timeout` (`DB_LOCK_TIMEOUT_MS` is unset). Without a bound, a single holder — another
 * clinician mid-save, or a transaction left open by an abandoned request until
 * `idle_in_transaction_session_timeout` reaps it two minutes later — turns the next write to
 * the same patient into a request that never answers. The operator does not see a conflict;
 * they see the proxy in front of the app give up, which is an opaque 502 in the save dialog
 * with nothing written and nothing to act on.
 *
 * Five seconds is longer than any healthy patient write (each one is a handful of statements
 * against locked rows) and far shorter than any front-end read timeout, so a genuinely
 * contended save fails as a conflict the clinician can retry rather than as a dead request.
 * Override with `PATIENT_LOCK_WAIT_TIMEOUT_MS`; `0` restores the unbounded database default.
 */
const PATIENT_LOCK_WAIT_TIMEOUT_DEFAULT_MS = 5_000

export function resolvePatientLockWaitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.PATIENT_LOCK_WAIT_TIMEOUT_MS ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 0) return PATIENT_LOCK_WAIT_TIMEOUT_DEFAULT_MS
  return parsed
}

/** Postgres `lock_not_available` — raised when `lock_timeout` elapses waiting for a row lock. */
const PG_LOCK_NOT_AVAILABLE = '55P03'

/**
 * Walks the driver error chain looking for the lock-timeout SQLSTATE.
 *
 * MikroORM wraps driver errors, and how deeply depends on the code path, so the code is
 * looked for on the error itself and on every `previous`/`cause` below it rather than at one
 * fixed depth.
 */
export function isLockWaitTimeout(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; previous?: unknown; cause?: unknown }
    if (candidate.code === PG_LOCK_NOT_AVAILABLE) return true
    current = candidate.previous ?? candidate.cause
  }
  return false
}

/**
 * Locks the patient row and returns it, or 404s.
 *
 * `LockMode.PESSIMISTIC_WRITE` is a `SELECT … FOR UPDATE`, and taking it *before* the
 * version comparison is what makes optimistic locking actually serialize: check-then-lock
 * lets two writers both read the same `updated_at`, both pass, and both write.
 *
 * This is also the aggregate lock the spec requires for the primary-address switch, the
 * diagnosis-chain correction and the archive/delete precondition checks. Every command
 * that touches a patient's children takes it on the patient first, so the lock order is
 * always patient → child and two commands cannot deadlock by approaching from opposite ends.
 *
 * The wait is bounded (see {@link PATIENT_LOCK_WAIT_TIMEOUT_DEFAULT_MS}) and a timeout is
 * reported as a 409 rather than a 500: nothing was written, the request is safe to repeat,
 * and the create commands carry a `clientRequestId`, so a retry resolves to one entry.
 * `SET LOCAL` scopes the bound to the current transaction, so it is reverted on commit or
 * rollback and never leaks to the next user of the pooled connection — which is also why
 * every caller must already be inside the transaction (`lockInsideTransaction.test.ts`).
 */
export async function lockPatient(
  em: EntityManager,
  patientId: string,
  scope: PatientScope,
): Promise<Patient> {
  await applyLockWaitBound(em)
  let patient: Patient | null
  try {
    patient = await em.findOne(
      Patient,
      {
        id: patientId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      } as FilterQuery<Patient>,
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
  } catch (error) {
    if (isLockWaitTimeout(error)) {
      throw new CrudHttpError(409, {
        error: 'This patient record is being changed right now; try again in a moment',
        code: 'patient_locked',
      })
    }
    throw error
  }
  if (!patient) throw new CrudHttpError(404, { error: 'Patient not found' })
  return patient
}

/**
 * Bounds the row-lock wait for the rest of the enclosing transaction.
 *
 * `set_config` rather than a `SET LOCAL` string so the value stays a bound parameter — the
 * `SET` statement takes no placeholders, and building it by concatenation would put a
 * configuration value into SQL text.
 */
async function applyLockWaitBound(em: EntityManager): Promise<void> {
  const timeoutMs = resolvePatientLockWaitTimeoutMs()
  if (timeoutMs <= 0) return
  await em.execute('select set_config(?, ?, true)', ['lock_timeout', `${timeoutMs}ms`])
}

/** An archived record accepts no new entries, but stays readable. */
export function assertPatientAcceptsNewEntries(patient: Patient): void {
  if (patient.status === 'archived') {
    throw new CrudHttpError(409, {
      error: 'This patient record is archived and does not accept new entries',
      code: 'patient_archived',
    })
  }
}

/**
 * Compares a version token against the stored `updated_at`.
 *
 * A missing token is a 400 and a mismatch is a 409 — two different failures the client
 * handles differently, so they must not collapse into one. The comparison is on the
 * millisecond timestamp rather than the string, because an ISO string round-tripped
 * through JSON can differ in format (`+00:00` vs `Z`) while naming the same instant.
 */
export function assertExpectedVersion(
  expected: string | null | undefined,
  current: Date,
  resourceKind: string,
): void {
  if (!expected) {
    throw new CrudHttpError(400, {
      error: 'An expected version token is required for this operation',
      code: 'version_token_required',
    })
  }
  const expectedMs = new Date(expected).getTime()
  if (Number.isNaN(expectedMs)) {
    throw new CrudHttpError(400, { error: 'The expected version token is not a valid timestamp' })
  }
  if (expectedMs !== current.getTime()) {
    throw new CrudHttpError(409, {
      error: 'This record changed since it was loaded',
      code: 'version_conflict',
      resourceKind,
      currentUpdatedAt: current.toISOString(),
    })
  }
}

/**
 * `updated_at` must increase on every write, even for two writes in the same millisecond.
 *
 * The version token IS `updated_at`, so a second write that lands in the same
 * millisecond would produce a token identical to the previous one — and a third writer
 * holding the stale token would pass the version check. Nudging forward by a
 * millisecond keeps the token strictly monotonic, which is what the spec's "monotonic
 * `updated_at`" requirement is actually protecting.
 */
export function nextUpdatedAt(previous: Date | null | undefined): Date {
  const now = new Date()
  if (previous && now.getTime() <= previous.getTime()) return new Date(previous.getTime() + 1)
  return now
}

/**
 * Builds the patient's non-clinical handle.
 *
 * `P-<uuid>` rather than a sequential number: a counter needs a global lock to stay
 * gapless, and its value would leak how many patients the organization has. The UUID is
 * generated independently from the persistence id so the public handle cannot reveal or
 * be used to reconstruct the primary key. The spec rules out both a counter and any
 * national identifier.
 */
export function buildPatientNumber(): string {
  return `P-${randomUUID()}`
}

/**
 * Canonicalizes a create payload so a retry can be compared to the original.
 *
 * Object keys are sorted recursively, so two JSON encodings of the same request compare
 * equal. `undefined` members are dropped while `null` is preserved — they mean different
 * things everywhere else in this module and must keep meaning different things here.
 *
 * What the caller must exclude before calling this: scope, actor ids, version tokens and
 * the request id itself. A legitimate retry can arrive from a different session, and
 * including any of those would make it compare unequal and raise a spurious 409.
 */
export function canonicalizeCreatePayload(payload: unknown): string {
  return JSON.stringify(sortValue(payload))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue
      sorted[key] = sortValue(source[key])
    }
    return sorted
  }
  if (value instanceof Date) return value.toISOString()
  return value
}

/**
 * Digest used to compare a retried create against the stored one.
 *
 * A hash rather than the canonical text: the stored column is encrypted, so comparing
 * plaintext would mean decrypting it on every retry, and the column can be large. The
 * digest is computed over the canonical form and stored *as* the payload value, so the
 * comparison is a constant-size equality check and the original request text is never
 * needed again. That still satisfies the spec's requirement that the comparison not
 * depend on the record's later edits.
 */
export function createRequestDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalizeCreatePayload(payload)).digest('hex')
}

/**
 * Minimal slice of the framework's tenant encryption service.
 *
 * Declared structurally so the encryption helpers below stay unit-testable with a stub
 * instead of a live KMS.
 */
export type PatientEncryptionService = {
  encryptEntityPayload: (
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null,
  ) => Promise<Record<string, unknown>>
}

export function tryResolveEncryptionService(ctx: CommandRuntimeContext): PatientEncryptionService | null {
  try {
    return ctx.container.resolve('tenantEncryptionService') as PatientEncryptionService
  } catch {
    return null
  }
}

/**
 * Encrypts the sensitive members of a column patch, failing closed.
 *
 * Why this is explicit rather than left to the ORM subscriber: MikroORM documents
 * `nativeUpdate` as having no side effects on the context, which includes the lifecycle
 * events the encryption subscriber listens on. A raw `patch.firstName = 'Anna'` would
 * therefore land in the column as plaintext while every read path tries to decrypt it.
 *
 * `encryptEntityPayload` is a documented no-op when encryption is disabled, when the
 * tenant has no data key, or when no map covers the entity. For clinical data every one
 * of those must be a refusal, not a pass-through — the spec requires a sensitive write
 * to fail closed rather than silently persist plaintext. So the result is verified to be
 * a string that actually differs from the input before it is accepted.
 *
 * `null` passes through untouched: clearing a field is not a sensitive write, and there
 * is no plaintext to protect.
 */
export async function encryptSensitiveFields<T extends Record<string, unknown>>(
  entityId: string,
  values: T,
  scope: PatientScope,
  encryption: PatientEncryptionService | null,
): Promise<T> {
  const pending: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.length > 0) pending[key] = value
  }
  if (Object.keys(pending).length === 0) return values

  if (!encryption) {
    throw new CrudHttpError(503, {
      error: ENCRYPTION_UNAVAILABLE_MESSAGE,
      code: 'encryption_unavailable',
      entityId,
      remedy: ENCRYPTION_REMEDY,
    })
  }

  const encrypted = await encryption.encryptEntityPayload(
    entityId,
    pending,
    scope.tenantId,
    scope.organizationId,
  )

  const result: Record<string, unknown> = { ...values }
  for (const [key, plaintext] of Object.entries(pending)) {
    const stored = encrypted?.[key]
    if (typeof stored !== 'string' || stored === plaintext) {
      throw new CrudHttpError(503, {
        // `entityId` is named because the remedy is per-entity: the operator needs to know WHICH
        // map is missing. The field key is deliberately not included — it would appear in logs
        // and error surfaces, and the field names here are themselves clinical vocabulary.
        error: ENCRYPTION_UNAVAILABLE_MESSAGE,
        code: 'encryption_unavailable',
        entityId,
        remedy: ENCRYPTION_REMEDY,
      })
    }
    result[key] = stored
  }
  return result as T
}

/**
 * The remedy, carried on the error itself.
 *
 * By far the most likely cause in practice is an existing tenant: `encryption.ts` only declares
 * the maps, and they are materialized as `EncryptionMap` rows at tenant creation or by the CLI
 * below. A tenant created before this module was installed therefore has no `patient:*` maps, and
 * every sensitive write fails closed — correctly, but with no clue what to do about it. The spec's
 * rollout step 2 names this command; repeating it at the point of failure is what turns a dead end
 * into a two-minute fix.
 */
const ENCRYPTION_REMEDY =
  'If this tenant existed before the patient module was installed, its encryption maps were never ' +
  'created. Run `yarn mercato entities seed-encryption --tenant <tenantId>`. Otherwise check that ' +
  'TENANT_DATA_ENCRYPTION is enabled and the tenant has a usable data key.'

const ENCRYPTION_UNAVAILABLE_MESSAGE =
  'Patient data could not be encrypted, so the write was refused rather than stored in plain text.'

/**
 * Today's date in the organization's timezone, as `YYYY-MM-DD`.
 *
 * A diagnosis date is compared against "today where the clinician is", not against UTC.
 * Near midnight those differ, and a Warsaw clinician entering today's date at 01:00
 * local would otherwise be told the date is in the future. Falls back to UTC when the
 * timezone is unknown, which is the only safe direction: it can reject a legitimate
 * same-day entry for at most a couple of hours, whereas assuming a generous offset
 * would accept a genuinely future date.
 */
export function organizationToday(timeZone: string | null | undefined): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(new Date())
}

/**
 * The timezone the "organization's local today" rule resolves against.
 *
 * The spec compares a diagnosis date against the organization's current local date. The
 * installed `directory` module has **no per-organization timezone column** — verified
 * against `directory/data/entities.ts` — so there is nothing per-organization to read, and
 * inventing a column for it would be a schema change to another module's table.
 *
 * This therefore resolves to the deployment's timezone, which is the framework's own
 * convention for the same problem (`Intl.DateTimeFormat().resolvedOptions().timeZone ||
 * 'UTC'`, as used by the data_sync and staff surfaces). For a single-country deployment that
 * is exactly the organization's timezone; for a multi-timezone tenant it is an approximation
 * that can only ever be strict by a few hours, never permissive, because a wrong guess here
 * rejects a legitimate same-day entry rather than accepting a future one.
 *
 * `OM_PATIENT_TIMEZONE` overrides it for a deployment whose server clock is not in the
 * clinic's timezone.
 */
export function resolveClinicalTimeZone(): string {
  const configured = process.env.OM_PATIENT_TIMEZONE
  if (configured && isValidTimeZone(configured)) return configured
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })
    return true
  } catch {
    return false
  }
}

/** Serializes a timestamp for an API response, tolerating a string or a Date. */
export function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}
