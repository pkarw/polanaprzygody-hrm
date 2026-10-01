import { createHash } from 'node:crypto'
import type { AwilixContainer } from 'awilix'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { readBoundedRequestBody, WebhookBodyTooLargeError } from '@open-mercato/shared/lib/webhooks'
import { ZodError } from 'zod'
import { BookingIntake } from '../data/entities'
import {
  bookingIntakeRecordSchema,
  publicBookingRequestSchema,
  type PublicBookingRequest,
} from '../data/validators'
import { Patient, PatientContactLink, type PatientVisit } from '../../patient/data/entities'
import { patientCreateSchema, patientVisitCreateSchema } from '../../patient/data/validators'
import { resolvePublicBookingRequestContext, type PublicBookingAuth } from './publicAuth'
import { publicBookingZonedInstant, resolvePublicBookingSlot } from './publicDiscovery'
import type { PublicBookingScope } from './commandSupport'
import {
  findCustomerByProjectedIdentity,
  reconcileCustomerIdentityProjection,
} from './customerIdentityProjection'

const logger = createLogger('public_booking').child({ component: 'submission' })
const PUBLIC_BOOKING_UUID_NAMESPACE = 'b963d887-2da8-5b87-942a-f0b79bc94d7d'
const TERMS_URL = 'https://polanaprzygody.pl/regulamin-swiadczenia-uslug'
const PRIVACY_URL = 'https://polanaprzygody.pl/polityka-prywatnosci'
const MAX_REQUEST_BYTES = 32 * 1024
const REQUIRED_SERVICE_FEATURES = [
  'customers.people.manage',
  'patient.patients.manage',
  'patient.visits.manage',
  'staff.view',
  'resources.view',
  'catalog.products.view',
] as const

type PublicBookingRbacService = {
  userHasAllFeatures(
    principalId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ): Promise<boolean>
  getGrantedFeatures(
    principalId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ): Promise<string[]>
}

type CustomerCreateResult = { entityId: string; personId: string }
type CommandResult<TResult> = { result: TResult; logEntry: { undoToken?: string | null } | null }
type GuardSuccess = { runAfterSuccess(): Promise<void> }

class PublicBookingCompensationRequired extends Error {
  constructor(
    readonly cause: unknown,
    readonly undoTokens: string[],
    readonly createdIds: string[],
  ) {
    super('Public booking orchestration requires compensation')
  }
}

export type PublicBookingSubmissionContext = {
  container: AwilixContainer
  em: EntityManager
  queryEngine: QueryEngine
  commandBus: CommandBus
  auth: PublicBookingAuth
  scope: PublicBookingScope
  request: Request
}

function normalizedEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized || null
}

function normalizedPhone(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

function normalizedName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

export function normalizePublicBookingRequest(input: PublicBookingRequest): PublicBookingRequest {
  return {
    ...input,
    // Canonicalize equivalent instants into the facility zone without erasing
    // the explicit local offset required by the patient scheduling contract.
    startsAt: publicBookingZonedInstant(new Date(input.startsAt)),
    endsAt: publicBookingZonedInstant(new Date(input.endsAt)),
    requester: {
      ...input.requester,
      email: normalizedEmail(input.requester.email) ?? undefined,
      phone: input.requester.phone.trim(),
    },
    patient: {
      ...input.patient,
      address: { ...input.patient.address, country: input.patient.address.country.toUpperCase() },
    },
  }
}

export function publicBookingPayloadHash(input: PublicBookingRequest): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(normalizePublicBookingRequest(input)))).digest('hex')
}

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex')
}

export function publicBookingUuidV5(name: string, namespace = PUBLIC_BOOKING_UUID_NAMESPACE): string {
  const digest = createHash('sha1').update(Buffer.concat([uuidBytes(namespace), Buffer.from(name)])).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function normalizeConfiguredOrigin(candidate: string): string | null {
  try {
    return new URL(candidate).origin
  } catch {
    return null
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function normalizedPort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80')
}

function originMatches(submitted: string, allowed: string): boolean {
  if (submitted === allowed) return true
  try {
    const left = new URL(submitted)
    const right = new URL(allowed)
    return left.protocol === right.protocol
      && normalizedPort(left) === normalizedPort(right)
      && isLoopback(left.hostname)
      && isLoopback(right.hostname)
  } catch {
    return false
  }
}

function authority(value: string): string | null {
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`)
    if (!parsed.hostname) return null
    const port = parsed.port && parsed.port !== '80' && parsed.port !== '443' ? `:${parsed.port}` : ''
    return `${parsed.hostname.toLowerCase()}${port}`
  } catch {
    return null
  }
}

export function configuredPublicBookingOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    env.APP_URL,
    env.NEXT_PUBLIC_APP_URL,
    ...(env.PUBLIC_BOOKING_ALLOWED_ORIGINS ?? '').split(','),
  ]
  const origins = new Set<string>()
  for (const raw of candidates) {
    if (!raw?.trim()) continue
    const origin = normalizeConfiguredOrigin(raw.trim())
    if (!origin) continue
    origins.add(origin)
    const parsed = new URL(origin)
    if (!isLoopback(parsed.hostname)) continue
    for (const hostname of ['localhost', '127.0.0.1']) {
      const variant = new URL(origin)
      variant.hostname = hostname
      origins.add(variant.origin)
    }
  }
  return [...origins]
}

export function validatePublicBookingOrigin(request: Request, env: NodeJS.ProcessEnv = process.env): void {
  const allowed = configuredPublicBookingOrigins(env)
  if (allowed.length === 0) {
    throw new CrudHttpError(503, { error: 'Public booking is temporarily unavailable' })
  }
  const allowedAuthorities = new Set(allowed.map(authority).filter((item): item is string => Boolean(item)))
  const forwardedHosts = (request.headers.get('x-forwarded-host') ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  const hostValues = forwardedHosts.length > 0
    ? forwardedHosts
    : (request.headers.get('host') ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  if (hostValues.length === 0 || !hostValues.every((item) => {
    const candidate = authority(item)
    return candidate !== null && allowedAuthorities.has(candidate)
  })) {
    throw new CrudHttpError(403, { error: 'Invalid request host' })
  }
  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')
  let submitted = origin
  if (!submitted && referer) {
    try {
      submitted = new URL(referer).origin
    } catch {
      throw new CrudHttpError(403, { error: 'Invalid request origin' })
    }
  }
  if (!submitted || !allowed.some((candidate) => originMatches(submitted!, candidate))) {
    throw new CrudHttpError(403, { error: 'Invalid request origin' })
  }
}

export function assertPublicBookingRequestSize(request: Request): void {
  const raw = request.headers.get('content-length')
  if (!raw) return
  const size = Number(raw)
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_REQUEST_BYTES) {
    throw new CrudHttpError(400, { error: 'Invalid booking request' })
  }
}

export async function readPublicBookingRequestBody(request: Request): Promise<Record<string, unknown>> {
  assertPublicBookingRequestSize(request)
  try {
    const raw = await readBoundedRequestBody(request, { maxBytes: MAX_REQUEST_BYTES })
    return await readJsonSafe<Record<string, unknown>>(raw, {}) ?? {}
  } catch (error) {
    if (error instanceof WebhookBodyTooLargeError) {
      throw new CrudHttpError(400, { error: 'Invalid booking request' })
    }
    throw error
  }
}

async function acquireSubmissionLocks(
  em: EntityManager,
  scope: PublicBookingScope,
  key: string,
  input: PublicBookingRequest,
): Promise<void> {
  await em.execute('select set_config(?, ?, true)', ['lock_timeout', '5000ms'])
  const identities = [
    `idempotency:${scope.tenantId}:${scope.organizationId}:${key}`,
    normalizedEmail(input.requester.email) ? `email:${normalizedEmail(input.requester.email)}` : null,
    `phone:${normalizedPhone(input.requester.phone)}`,
  ].filter((value): value is string => Boolean(value)).sort()
  for (const identity of identities) {
    await em.execute('select pg_advisory_xact_lock(hashtextextended(?::text, 0))', [
      `public-booking:${scope.tenantId}:${scope.organizationId}:${identity}`,
    ])
  }
}

async function findIntakeReplay(
  em: EntityManager,
  scope: PublicBookingScope,
  key: string,
  hash: string,
): Promise<BookingIntake | null> {
  const intake = await em.findOne(BookingIntake, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    clientIdempotencyKey: key,
    deletedAt: null,
  } as FilterQuery<BookingIntake>)
  if (!intake) return null
  if (intake.requestPayloadHash !== hash) {
    throw new CrudHttpError(409, {
      error: 'This idempotency key was already used with different content',
      code: 'idempotency_payload_mismatch',
    })
  }
  return intake
}

async function runGuard(
  ctx: PublicBookingSubmissionContext,
  resourceKind: string,
  payload: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; success: GuardSuccess }> {
  if (!ctx.auth.userId) throw new CrudHttpError(503, { error: 'Public booking is temporarily unavailable' })
  const guard = await runRouteMutationGuards({
    container: ctx.container,
    req: ctx.request,
    auth: {
      userId: ctx.auth.userId,
      tenantId: ctx.scope.tenantId,
      organizationId: ctx.scope.organizationId,
      userFeatures: ctx.auth.features,
    },
    input: { resourceKind, operation: 'create', mutationPayload: payload },
  })
  if (!guard.ok) throw new CrudHttpError(guard.errorStatus, guard.errorBody)
  return { payload: { ...payload, ...(guard.modifiedPayload ?? {}) }, success: guard }
}

async function matchPatient(
  em: EntityManager,
  scope: PublicBookingScope,
  customerEntityId: string,
  patientInput: PublicBookingRequest['patient'],
): Promise<string | null> {
  const links = await em.find(PatientContactLink, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    customerEntityId,
    deletedAt: null,
  } as FilterQuery<PatientContactLink>, { fields: ['patientId'], limit: 101 })
  if (links.length > 100) throw new CrudHttpError(503, { error: 'Public booking is temporarily unavailable' })
  const patientIds = [...new Set(links.map((link) => link.patientId))]
  if (patientIds.length === 0) return null
  const patients = await findWithDecryption(em, Patient, {
    id: { $in: patientIds },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
  } as FilterQuery<Patient>, { limit: 101 }, scope)
  const firstName = normalizedName(patientInput.firstName)
  const lastName = normalizedName(patientInput.lastName)
  const matches = patients.filter((patient) => (
    normalizedName(patient.firstName) === firstName && normalizedName(patient.lastName) === lastName
  ))
  return matches.length === 1 ? matches[0]!.id : null
}

function commandContext(ctx: PublicBookingSubmissionContext): CommandRuntimeContext {
  return {
    container: ctx.container,
    auth: ctx.auth as CommandRuntimeContext['auth'],
    organizationScope: null,
    selectedOrganizationId: ctx.scope.organizationId,
    organizationIds: [ctx.scope.organizationId],
    request: ctx.request,
  }
}

async function executeAudited<T>(
  ctx: PublicBookingSubmissionContext,
  commandId: string,
  input: Record<string, unknown>,
): Promise<CommandResult<T>> {
  if (!ctx.auth.userId) throw new CrudHttpError(503, { error: 'Public booking is temporarily unavailable' })
  return await ctx.commandBus.execute<Record<string, unknown>, T>(commandId, {
    input,
    ctx: commandContext(ctx),
    metadata: { actorUserId: ctx.auth.userId },
  }) as CommandResult<T>
}

async function compensate(
  ctx: PublicBookingSubmissionContext,
  undoTokens: string[],
  createdIds: string[],
): Promise<void> {
  try {
    for (const token of [...undoTokens].reverse()) {
      await ctx.commandBus.undo(token, commandContext(ctx))
    }
  } catch (error) {
    logger.error('Public booking compensation failed', { createdIds, err: error })
    throw new CrudHttpError(503, { error: 'Public booking is temporarily unavailable' })
  }
}

export async function buildPublicBookingSubmissionContext(
  request: Request,
  container: AwilixContainer,
): Promise<PublicBookingSubmissionContext> {
  const em = container.resolve<EntityManager>('em')
  const queryEngine = container.resolve<QueryEngine>('queryEngine')
  const commandBus = container.resolve<CommandBus>('commandBus')
  const { auth, scope } = await resolvePublicBookingRequestContext(em, container)
  let rbac: PublicBookingRbacService
  try {
    rbac = container.resolve<PublicBookingRbacService>('rbacService')
  } catch {
    throw new CrudHttpError(503, { error: 'Public booking is temporarily unavailable' })
  }
  const rbacScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  if (!(await rbac.userHasAllFeatures(auth.sub, [...REQUIRED_SERVICE_FEATURES], rbacScope))) {
    throw new CrudHttpError(503, { error: 'Public booking is temporarily unavailable' })
  }
  // API-key authentication intentionally returns identity and role names only.
  // Resolve grants through the authoritative RBAC service and carry that checked
  // projection into mutation guards; never infer privileges from role names.
  auth.features = await rbac.getGrantedFeatures(auth.sub, rbacScope)
  return { container, em, queryEngine, commandBus, auth, scope, request }
}

export async function submitPublicBookingRequest(
  ctx: PublicBookingSubmissionContext,
  rawInput: PublicBookingRequest,
  idempotencyKey: string,
  now = new Date(),
): Promise<void> {
  const input = normalizePublicBookingRequest(publicBookingRequestSchema.parse(rawInput))
  const payloadHash = publicBookingPayloadHash(input)
  const lockEm = ctx.em.fork()
  try {
    await lockEm.transactional(async (transactionalEm) => {
      await acquireSubmissionLocks(transactionalEm, ctx.scope, idempotencyKey, input)
      if (await findIntakeReplay(transactionalEm, ctx.scope, idempotencyKey, payloadHash)) return

      const undoTokens: string[] = []
      const createdIds: string[] = []
      const afterSuccess: GuardSuccess[] = []
      try {
        const slot = await resolvePublicBookingSlot({
          em: ctx.em.fork(),
          container: ctx.container,
          queryEngine: ctx.queryEngine,
          scope: ctx.scope,
          productId: input.productId,
          teamMemberId: input.teamMemberId,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          timeZone: input.timeZone,
          now,
        })

        let customerEntityId = await findCustomerByProjectedIdentity(ctx.em.fork(), ctx.scope, input.requester)
        if (!customerEntityId) {
          const customerInput = {
            tenantId: ctx.scope.tenantId,
            organizationId: ctx.scope.organizationId,
            firstName: input.requester.firstName,
            lastName: input.requester.lastName,
            displayName: `${input.requester.firstName} ${input.requester.lastName}`,
            primaryEmail: input.requester.email,
            primaryPhone: input.requester.phone,
            source: 'public-booking',
          }
          const guarded = await runGuard(ctx, 'customers.person', customerInput)
          const commandInput = { ...guarded.payload, tenantId: ctx.scope.tenantId, organizationId: ctx.scope.organizationId }
          const created = await executeAudited<CustomerCreateResult>(ctx, 'customers.people.create', commandInput)
          customerEntityId = created.result.entityId
          afterSuccess.push(guarded.success)
          createdIds.push(customerEntityId)
          if (created.logEntry?.undoToken) undoTokens.push(created.logEntry.undoToken)
          await reconcileCustomerIdentityProjection(ctx.em.fork(), ctx.scope, customerEntityId)
        }

        let patientId = await matchPatient(ctx.em.fork(), ctx.scope, customerEntityId, input.patient)
        if (!patientId) {
          const patientInput = {
            firstName: input.patient.firstName,
            lastName: input.patient.lastName,
            email: input.requester.email,
            phone: input.requester.phone,
            primaryAddress: {
              addressLine1: input.patient.address.street,
              city: input.patient.address.city,
              postalCode: input.patient.address.postalCode,
              country: input.patient.address.country,
            },
            contacts: [{
              customerEntityId,
              isContact: true,
              isPayer: true,
              isPrimaryContact: true,
            }],
            clientRequestId: publicBookingUuidV5(`${idempotencyKey}:patient.patients.create`),
          }
          const guarded = await runGuard(ctx, 'patient.patient', patientInput)
          const commandInput = patientCreateSchema.parse(guarded.payload)
          const created = await executeAudited<Patient>(ctx, 'patient.patients.create', commandInput)
          patientId = created.result.id
          afterSuccess.push(guarded.success)
          createdIds.push(patientId)
          if (created.logEntry?.undoToken) undoTokens.push(created.logEntry.undoToken)
        }

        const visitInput = {
          patientId,
          teamMemberId: input.teamMemberId,
          resourceId: slot.resourceId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          timeZone: input.timeZone,
          serviceProductIds: [input.productId],
          clientRequestId: publicBookingUuidV5(`${idempotencyKey}:patient.visits.create`),
        }
        const guardedVisit = await runGuard(ctx, 'patient.visit', visitInput)
        const visit = await executeAudited<PatientVisit>(
          ctx,
          'patient.visits.create',
          patientVisitCreateSchema.parse(guardedVisit.payload),
        )
        afterSuccess.push(guardedVisit.success)
        createdIds.push(visit.result.id)
        if (visit.logEntry?.undoToken) undoTokens.push(visit.logEntry.undoToken)

        const submittedAt = now.toISOString()
        const intakeInput = {
          visitId: visit.result.id,
          customerEntityId,
          patientId,
          productId: input.productId,
          requesterNameSnapshot: `${input.requester.firstName} ${input.requester.lastName}`,
          requesterEmailSnapshot: input.requester.email ?? null,
          requesterPhoneSnapshot: input.requester.phone,
          consentProof: {
            terms: { url: TERMS_URL, acceptedAt: submittedAt },
            privacyPolicy: { url: PRIVACY_URL, acceptedAt: submittedAt },
          },
          clientIdempotencyKey: idempotencyKey,
          requestPayloadHash: payloadHash,
        }
        const guardedIntake = await runGuard(ctx, 'public_booking.booking_intake', intakeInput)
        await executeAudited<BookingIntake>(
          ctx,
          'public_booking.intake.record',
          bookingIntakeRecordSchema.parse(guardedIntake.payload),
        )
        afterSuccess.push(guardedIntake.success)
        for (const guard of afterSuccess) await guard.runAfterSuccess()
      } catch (error) {
        // A raced intake is authoritative even if the command returned through an
        // infrastructure error after its durable insert.
        const replay = await findIntakeReplay(ctx.em.fork(), ctx.scope, idempotencyKey, payloadHash)
        if (replay) return
        // End the advisory-lock transaction before invoking command undo. The
        // installed action-log service claims and finalizes undo through distinct
        // entity-manager forks; doing that inside this transaction self-blocks.
        throw new PublicBookingCompensationRequired(error, undoTokens, createdIds)
      }
    })
  } catch (error) {
    if (!(error instanceof PublicBookingCompensationRequired)) throw error
    await compensate(ctx, error.undoTokens, error.createdIds)
    throw error.cause
  }
}

export function publicBookingSubmissionError(error: unknown): { status: number; body: { error: string } } {
  if (error instanceof ZodError) {
    return { status: 400, body: { error: 'Invalid booking request' } }
  }
  if (isCrudHttpError(error)) {
    if (error.status === 400) {
      return { status: 400, body: { error: 'Invalid booking request' } }
    }
    if (error.status === 403) {
      return { status: 403, body: { error: 'Booking request refused' } }
    }
    if (error.status === 404) {
      return { status: 404, body: { error: 'The selected service or therapist is unavailable' } }
    }
    if (error.status === 429) {
      return { status: 429, body: { error: 'Too many booking attempts. Please try again later.' } }
    }
    if (error.status === 409) {
      if (error.body.code === 'idempotency_payload_mismatch') {
        return { status: 409, body: { error: 'This idempotency key was already used with different content' } }
      }
      return { status: 409, body: { error: 'The selected appointment time is no longer available' } }
    }
    if (error.status === 422) {
      const code = String(error.body.error ?? '')
      if (code.startsWith('visit_conflict_') || 'conflicts' in error.body) {
        return { status: 409, body: { error: 'The selected appointment time is no longer available' } }
      }
      return { status: 422, body: { error: 'The booking request cannot be accepted' } }
    }
  }
  return { status: 503, body: { error: 'Public booking is temporarily unavailable' } }
}
