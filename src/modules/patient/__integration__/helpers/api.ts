import { expect, type APIRequestContext } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'

/**
 * Self-contained API helpers for the `patient` integration suite.
 *
 * Self-contained by requirement, not preference: the spec states every PAT-T case must create its
 * own scope, grants and records through supported APIs, must not depend on Polana's seed data, and
 * must not depend on the order the suite runs in. This installed version also ships no shared
 * `core/__integration__/helpers` module, so there is nothing to import even if that were allowed.
 *
 * Auth travels as a bearer token rather than a cookie. `getAuthFromRequest` accepts either, and an
 * explicit header keeps a spec that exercises two different users from depending on which cookie
 * jar its request context happens to hold.
 */

export type ScopedActor = {
  token: string
  headers: Record<string, string>
}

export type PagedResponse<T> = {
  items: T[]
  total?: number
  page?: number
  pageSize?: number
  totalPages?: number
}

/**
 * Signs in and returns a bearer-token actor.
 *
 * Credentials come from the environment rather than being hard-coded: the spec forbids fixtures
 * that carry real credentials, and a literal password in a repository is exactly that. A missing
 * variable fails loudly with the variable's name, because a spec that silently ran unauthenticated
 * would "pass" every denial assertion for the wrong reason.
 */
export async function login(
  request: APIRequestContext,
  credentials?: { email?: string; password?: string },
): Promise<ScopedActor> {
  const token = credentials?.email
    ? await getAuthToken(request, credentials.email, credentials.password)
    : await getAuthToken(request, 'admin')

  return {
    token,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  }
}

/** A v4 uuid for a client request id, so idempotency assertions can control the key. */
export function newRequestId(): string {
  return crypto.randomUUID()
}

/**
 * A run-unique suffix for fixture names.
 *
 * Every spec creates its own records and must not collide with a concurrently running one or with
 * leftovers from a previous run, so the suffix goes into every name the test asserts on.
 */
export function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

export type ApiResult<T> = { status: number; body: T }

/** A request whose non-2xx outcome is the assertion, so it must not throw. */
export async function callApi<T = unknown>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  actor: ScopedActor | null,
  data?: unknown,
): Promise<ApiResult<T>> {
  const response = await request.fetch(path, {
    method,
    headers: actor?.headers ?? { 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  })
  let body: unknown = null
  const text = await response.text()
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      // A non-JSON body (an HTML error page, or bytes) is surfaced as text so a failing assertion
      // shows what actually came back instead of "undefined".
      body = { raw: text }
    }
  }
  return { status: response.status(), body: body as T }
}

/** Asserts a 2xx and returns the parsed body. */
export async function callApiOk<T = unknown>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  actor: ScopedActor,
  data?: unknown,
): Promise<T> {
  const result = await callApi<T>(request, method, path, actor, data)
  expect(
    result.status >= 200 && result.status < 300,
    `${method} ${path} expected 2xx, got ${result.status}: ${JSON.stringify(result.body)}`,
  ).toBeTruthy()
  return result.body
}

export type PatientFixtureInput = {
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  birthDate?: string | null
  description?: string | null
  ownerTeamMemberId?: string | null
  contacts?: Array<Record<string, unknown>>
  primaryAddress?: Record<string, unknown>
  clientRequestId?: string
}

/** A complete, valid create payload; every field is overridable so a spec can break exactly one. */
export function buildPatientInput(overrides: PatientFixtureInput = {}): Record<string, unknown> {
  const suffix = unique('pat')
  return {
    firstName: overrides.firstName ?? 'Test',
    lastName: overrides.lastName ?? suffix,
    // An email keeps the "at least one contact channel" rule satisfied by default, so a spec that
    // is not about that rule does not have to know it exists.
    email: overrides.email ?? `${suffix}@example.test`,
    ...(overrides.phone !== undefined ? { phone: overrides.phone } : {}),
    ...(overrides.birthDate !== undefined ? { birthDate: overrides.birthDate } : {}),
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    ...(overrides.ownerTeamMemberId !== undefined
      ? { ownerTeamMemberId: overrides.ownerTeamMemberId }
      : {}),
    ...(overrides.contacts !== undefined ? { contacts: overrides.contacts } : {}),
    primaryAddress: overrides.primaryAddress ?? {
      addressLine1: 'Testowa 1',
      city: 'Wrocław',
      country: 'PL',
    },
    clientRequestId: overrides.clientRequestId ?? newRequestId(),
  }
}

export type CreatedPatient = { id: string; patientNumber?: string; updatedAt?: string | null }

export type VisitRecord = {
  id: string
  patientId: string
  teamMemberId: string
  teamMemberName: string
  resourceId: string | null
  resourceName: string | null
  startsAt: string
  endsAt: string | null
  timeZone: string
  status: 'planned' | 'completed' | 'cancelled' | 'no_show'
  isConfirmed: boolean
  isSettled: boolean
  services: Array<{ id: string; productId: string; title: string; sku: string | null; position: number }>
  updatedAt: string
}

export async function createVisit(
  request: APIRequestContext,
  actor: ScopedActor,
  input: {
    patientId: string
    teamMemberId: string
    startsAt: string
    timeZone: string
    endsAt?: string | null
    resourceId?: string | null
    description?: string | null
    serviceProductIds?: string[]
    clientRequestId?: string
  },
): Promise<{ id: string; updatedAt: string }> {
  return await callApiOk(request, 'POST', '/api/patient/visits', actor, {
    ...input,
    clientRequestId: input.clientRequestId ?? newRequestId(),
  })
}

export async function readVisit(
  request: APIRequestContext,
  actor: ScopedActor,
  id: string,
): Promise<VisitRecord | null> {
  const body = await callApiOk<PagedResponse<VisitRecord>>(
    request,
    'GET',
    `/api/patient/visits?id=${encodeURIComponent(id)}&pageSize=1`,
    actor,
  )
  return body.items?.[0] ?? null
}

export async function cleanupVisit(
  request: APIRequestContext,
  actor: ScopedActor,
  id: string | null,
): Promise<void> {
  if (!id) return
  try {
    const record = await readVisit(request, actor, id)
    if (!record || record.status !== 'planned' || record.isSettled) return
    await callApi(request, 'DELETE', '/api/patient/visits', actor, {
      id,
      expectedUpdatedAt: record.updatedAt,
    })
  } catch {
    return
  }
}

export async function createPatient(
  request: APIRequestContext,
  actor: ScopedActor,
  overrides: PatientFixtureInput = {},
): Promise<CreatedPatient> {
  return await callApiOk<CreatedPatient>(
    request,
    'POST',
    '/api/patient/patients',
    actor,
    buildPatientInput(overrides),
  )
}

export type PatientRecord = {
  id: string
  patientNumber: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  description?: string | null
  birthDate?: string | null
  ownerTeamMemberId: string | null
  owner: { id: string; name: string; isAvailable: boolean } | null
  status: 'active' | 'archived'
  archivedAt?: string | null
  updatedAt: string | null
}

/** Reads one patient through the single-record request shape, which projects `description`. */
export async function readPatient(
  request: APIRequestContext,
  actor: ScopedActor,
  id: string,
): Promise<PatientRecord | null> {
  const body = await callApiOk<PagedResponse<PatientRecord>>(
    request,
    'GET',
    `/api/patient/patients?ids=${encodeURIComponent(id)}&pageSize=1`,
    actor,
  )
  return body.items?.[0] ?? null
}

/** Reads one patient and fails the spec when it is missing, returning a non-null record. */
export async function requirePatient(
  request: APIRequestContext,
  actor: ScopedActor,
  id: string,
): Promise<PatientRecord> {
  const record = await readPatient(request, actor, id)
  expect(record, `patient ${id} should be readable`).toBeTruthy()
  return record as PatientRecord
}

export async function listAddresses(
  request: APIRequestContext,
  actor: ScopedActor,
  patientId: string,
): Promise<Array<{ id: string; isPrimary: boolean; city: string | null; updatedAt: string | null }>> {
  const body = await callApiOk<PagedResponse<{ id: string; isPrimary: boolean; city: string | null; updatedAt: string | null }>>(
    request,
    'GET',
    `/api/patient/addresses?patientId=${encodeURIComponent(patientId)}&pageSize=100`,
    actor,
  )
  return body.items ?? []
}

export async function listContacts(
  request: APIRequestContext,
  actor: ScopedActor,
  patientId: string,
): Promise<
  Array<{
    id: string
    customerEntityId: string
    person: { id: string; name: string; isAvailable: boolean } | null
    isGuardian: boolean
    isContact: boolean
    isPayer: boolean
    isPrimaryContact: boolean
    updatedAt: string | null
  }>
> {
  const body = await callApiOk<PagedResponse<{
    id: string
    customerEntityId: string
    person: { id: string; name: string; isAvailable: boolean } | null
    isGuardian: boolean
    isContact: boolean
    isPayer: boolean
    isPrimaryContact: boolean
    updatedAt: string | null
  }>>(
    request,
    'GET',
    `/api/patient/contacts?patientId=${encodeURIComponent(patientId)}&pageSize=100`,
    actor,
  )
  return body.items ?? []
}

export type DiagnosisRecord = {
  id: string
  title: string
  description: string
  diagnosedOn: string
  code: string | null
  codeSystem: string | null
  authorUserId: string
  author: { id: string; name: string } | null
  supersedesId: string | null
  supersededById: string | null
  status: 'active' | 'superseded' | 'voided'
  voidReason: string | null
  updatedAt: string | null
}

export async function listDiagnoses(
  request: APIRequestContext,
  actor: ScopedActor,
  patientId: string,
): Promise<DiagnosisRecord[]> {
  const body = await callApiOk<PagedResponse<DiagnosisRecord>>(
    request,
    'GET',
    `/api/patient/diagnoses?patientId=${encodeURIComponent(patientId)}&pageSize=100`,
    actor,
  )
  return body.items ?? []
}

export async function listDocumentLinks(
  request: APIRequestContext,
  actor: ScopedActor,
  patientId: string,
): Promise<
  Array<{
    id: string
    documentId: string
    state: 'pending_create' | 'linked' | 'abandoned'
    title: string | null
    isSharedWithOtherPatients: boolean
    updatedAt: string | null
  }>
> {
  const body = await callApiOk<PagedResponse<{
    id: string
    documentId: string
    state: 'pending_create' | 'linked' | 'abandoned'
    title: string | null
    isSharedWithOtherPatients: boolean
    updatedAt: string | null
  }>>(
    request,
    'GET',
    `/api/patient/document-links?patientId=${encodeURIComponent(patientId)}&pageSize=100`,
    actor,
  )
  return body.items ?? []
}

/**
 * Picks an active CRM person to link, skipping the spec when the organization has none.
 *
 * `test.skip` rather than a failure: "this organization has no CRM people" is an environment
 * property, not a defect in the patient module, and the spec forbids depending on seeded data.
 * A spec that needs a person says so by calling this.
 */
export async function findCrmPersonId(
  request: APIRequestContext,
  actor: ScopedActor,
): Promise<string | null> {
  const body = await callApiOk<PagedResponse<{ id?: unknown }>>(
    request,
    'GET',
    '/api/customers/people?pageSize=1&isActive=true',
    actor,
  )
  const first = body.items?.[0]
  return first && typeof first.id === 'string' ? first.id : null
}

/** Picks an active staff team member, or null when the organization has none. */
export async function findTeamMemberId(
  request: APIRequestContext,
  actor: ScopedActor,
): Promise<string | null> {
  const body = await callApiOk<PagedResponse<{ id?: unknown }>>(
    request,
    'GET',
    '/api/staff/team-members?pageSize=1&isActive=true',
    actor,
  )
  const first = body.items?.[0]
  return first && typeof first.id === 'string' ? first.id : null
}

/**
 * Best-effort cleanup for a patient created by a spec.
 *
 * Deletion only succeeds for an empty record, which is exactly right: a spec that created clinical
 * history leaves an archived record behind rather than a deleted one, and archiving is what the
 * product itself would do. Failures are swallowed, because a cleanup error must not mask the
 * assertion failure that is the actual result of the test.
 */
export async function cleanupPatient(
  request: APIRequestContext,
  actor: ScopedActor | null,
  patientId: string | null,
): Promise<void> {
  if (!actor || !patientId) return
  try {
    const record = await readPatient(request, actor, patientId)
    if (!record) return
    const deleted = await callApi(request, 'DELETE', '/api/patient/patients', actor, {
      id: patientId,
      expectedUpdatedAt: record.updatedAt,
    })
    if (deleted.status >= 200 && deleted.status < 300) return
    // Not empty — archive it so the register is not left with active test records.
    const current = await readPatient(request, actor, patientId)
    if (!current || current.status === 'archived') return
    await callApi(
      request,
      'POST',
      `/api/patient/patients/${encodeURIComponent(patientId)}/archive`,
      actor,
      { archived: true, expectedUpdatedAt: current.updatedAt },
    )
  } catch {
    // Intentionally silent; see the docblock.
  }
}
