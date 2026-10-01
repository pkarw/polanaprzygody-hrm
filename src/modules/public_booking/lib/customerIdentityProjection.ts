import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { hashForLookup, lookupHashCandidates } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerIdentityProjection } from '../data/entities'
import type { PublicBookingScope } from './commandSupport'

const PROJECTION_CANDIDATE_LIMIT = 101
const BACKFILL_BATCH_SIZE = 200

export type CustomerIdentityInput = {
  email?: string | null
  phone?: string | null
}

export function normalizeCustomerIdentityEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized || null
}

export function normalizeCustomerIdentityPhone(value: string | null | undefined): string | null {
  const normalized = (value ?? '').replace(/\D/g, '')
  return normalized || null
}

function identityHashContext(scope: PublicBookingScope, field: 'email' | 'phone'): string {
  return `public_booking:customer_identity:${scope.tenantId}:${scope.organizationId}:${field}`
}

function identityHashes(scope: PublicBookingScope, input: CustomerIdentityInput): {
  emailHash: string | null
  phoneHash: string | null
} {
  const email = normalizeCustomerIdentityEmail(input.email)
  const phone = normalizeCustomerIdentityPhone(input.phone)
  return {
    emailHash: email ? hashForLookup(email, identityHashContext(scope, 'email')) : null,
    phoneHash: phone ? hashForLookup(phone, identityHashContext(scope, 'phone')) : null,
  }
}

export async function reconcileCustomerIdentityProjection(
  em: EntityManager,
  scope: PublicBookingScope,
  customerEntityId: string,
): Promise<void> {
  const customer = await findOneWithDecryption(em, CustomerEntity, {
    id: customerEntityId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  } as FilterQuery<CustomerEntity>, {
    fields: ['id', 'tenantId', 'organizationId', 'kind', 'isActive', 'deletedAt', 'primaryEmail', 'primaryPhone'],
  }, scope)

  if (!customer || customer.kind !== 'person' || !customer.isActive || customer.deletedAt) {
    await em.nativeDelete(CustomerIdentityProjection, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      customerEntityId,
    } as FilterQuery<CustomerIdentityProjection>)
    return
  }

  const hashes = identityHashes(scope, { email: customer.primaryEmail, phone: customer.primaryPhone })
  if (!hashes.emailHash && !hashes.phoneHash) {
    await em.nativeDelete(CustomerIdentityProjection, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      customerEntityId,
    } as FilterQuery<CustomerIdentityProjection>)
    return
  }

  const now = new Date()
  await em.upsert(CustomerIdentityProjection, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    customerEntityId,
    ...hashes,
    createdAt: now,
    updatedAt: now,
  }, {
    onConflictFields: ['tenantId', 'organizationId', 'customerEntityId'],
    onConflictExcludeFields: ['id', 'createdAt'],
  })
}

export async function findCustomerByProjectedIdentity(
  em: EntityManager,
  scope: PublicBookingScope,
  input: CustomerIdentityInput,
): Promise<string | null> {
  const email = normalizeCustomerIdentityEmail(input.email)
  const phone = normalizeCustomerIdentityPhone(input.phone)
  const clauses: FilterQuery<CustomerIdentityProjection>[] = []
  if (email) {
    clauses.push({ emailHash: { $in: lookupHashCandidates(email, identityHashContext(scope, 'email')) } })
  }
  if (phone) {
    clauses.push({ phoneHash: { $in: lookupHashCandidates(phone, identityHashContext(scope, 'phone')) } })
  }
  if (clauses.length === 0) return null

  const projections = await em.find(CustomerIdentityProjection, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    $or: clauses,
  } as FilterQuery<CustomerIdentityProjection>, {
    fields: ['customerEntityId'],
    limit: PROJECTION_CANDIDATE_LIMIT,
  })
  if (projections.length >= PROJECTION_CANDIDATE_LIMIT) {
    throw new CrudHttpError(503, { error: 'Public booking is temporarily unavailable' })
  }

  const customerIds = [...new Set(projections.map((projection) => projection.customerEntityId))]
  if (customerIds.length === 0) return null
  const customers = await findWithDecryption(em, CustomerEntity, {
    id: { $in: customerIds },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    kind: 'person',
    isActive: true,
    deletedAt: null,
  } as FilterQuery<CustomerEntity>, {
    fields: ['id', 'tenantId', 'organizationId', 'primaryEmail', 'primaryPhone'],
    limit: PROJECTION_CANDIDATE_LIMIT,
  }, scope)
  const matches = new Set(customers.filter((customer) => (
    (email !== null && normalizeCustomerIdentityEmail(customer.primaryEmail) === email)
    || (phone !== null && normalizeCustomerIdentityPhone(customer.primaryPhone) === phone)
  )).map((customer) => customer.id))
  if (matches.size > 1) {
    throw new CrudHttpError(503, { error: 'Public booking is temporarily unavailable' })
  }
  return matches.size === 1 ? [...matches][0]! : null
}

export async function backfillCustomerIdentityProjections(
  em: EntityManager,
  scope: PublicBookingScope,
): Promise<void> {
  let cursor: string | null = null
  do {
    const customers: CustomerEntity[] = await findWithDecryption(em, CustomerEntity, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      kind: 'person',
      ...(cursor ? { id: { $gt: cursor } } : {}),
    } as FilterQuery<CustomerEntity>, {
      orderBy: { id: 'asc' },
      limit: BACKFILL_BATCH_SIZE,
      fields: ['id', 'tenantId', 'organizationId', 'kind', 'isActive', 'deletedAt', 'primaryEmail', 'primaryPhone'],
    }, scope)
    for (const customer of customers) {
      await reconcileCustomerIdentityProjection(em, scope, customer.id)
    }
    cursor = customers.length === BACKFILL_BATCH_SIZE ? customers.at(-1)!.id : null
  } while (cursor)
}
