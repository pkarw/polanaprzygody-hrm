import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { AwilixContainer } from 'awilix'
import { provisionExecutionPrincipal } from '@open-mercato/core/modules/auth/lib/executionPrincipal'
import { createApiKey } from '@open-mercato/core/modules/api_keys/services/apiKeyService'
import { ApiKey } from '@open-mercato/core/modules/api_keys/data/entities'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'
import { ServiceCredential } from '../data/entities'
import defaultEncryptionMaps from '../encryption'
import {
  encryptPublicBookingFields,
  type PublicBookingEncryptionService,
  type PublicBookingScope,
} from './commandSupport'

export const PUBLIC_BOOKING_PRINCIPAL_KEY = 'public-booking'
export const PUBLIC_BOOKING_PRINCIPAL_FEATURES = [
  'catalog.products.view',
  'customers.people.manage',
  'patient.patients.manage',
  'patient.visits.manage',
  'resources.view',
  'staff.view',
] as const

export type PublicBookingPrincipal = { userId: string; roleId: string }
export type PublicBookingCredentialRef = {
  id: string
  serviceUserId: string
  apiKeyId: string
}

export type PublicBookingIdentityTransaction = {
  findCredential(scope: PublicBookingScope): Promise<PublicBookingCredentialRef | null>
  findApiKey(input: {
    id: string
    serviceUserId: string
    roleId: string
    scope: PublicBookingScope
  }): Promise<{ id: string } | null>
  retireCredential(id: string): Promise<void>
  retireApiKey(id: string): Promise<void>
  createApiKey(input: {
    serviceUserId: string
    roleId: string
    scope: PublicBookingScope
  }): Promise<{ id: string; secret: string }>
  createCredential(input: {
    serviceUserId: string
    apiKeyId: string
    secret: string
    scope: PublicBookingScope
  }): Promise<PublicBookingCredentialRef>
}

export type PublicBookingIdentityDependencies = {
  materializeEncryptionMaps(scope: PublicBookingScope): Promise<void>
  provisionPrincipal(scope: PublicBookingScope): Promise<PublicBookingPrincipal>
  transaction<T>(run: (trx: PublicBookingIdentityTransaction) => Promise<T>): Promise<T>
  isUniqueViolation(error: unknown): boolean
}

async function ensureInsideTransaction(
  trx: PublicBookingIdentityTransaction,
  scope: PublicBookingScope,
  principal: PublicBookingPrincipal,
): Promise<PublicBookingCredentialRef> {
  const existing = await trx.findCredential(scope)
  if (existing) {
    const liveKey = existing.serviceUserId === principal.userId
      ? await trx.findApiKey({
          id: existing.apiKeyId,
          serviceUserId: principal.userId,
          roleId: principal.roleId,
          scope,
        })
      : null
    if (liveKey) return existing
    await trx.retireCredential(existing.id)
    await trx.retireApiKey(existing.apiKeyId)
  }

  const key = await trx.createApiKey({
    serviceUserId: principal.userId,
    roleId: principal.roleId,
    scope,
  })
  return await trx.createCredential({
    serviceUserId: principal.userId,
    apiKeyId: key.id,
    secret: key.secret,
    scope,
  })
}

/** Idempotently reconciles one least-privilege service identity per tenant/org. */
export async function ensurePublicBookingIdentity(
  dependencies: PublicBookingIdentityDependencies,
  scope: PublicBookingScope,
): Promise<PublicBookingCredentialRef> {
  if (!scope.tenantId || !scope.organizationId) {
    throw new Error('[internal] public booking service identity requires tenant and organization scope')
  }
  // Existing tenants do not automatically receive maps declared by a newly-installed
  // module. Materialize them before the first secret can ever be written.
  await dependencies.materializeEncryptionMaps(scope)
  const principal = await dependencies.provisionPrincipal(scope)

  try {
    return await dependencies.transaction((trx) => ensureInsideTransaction(trx, scope, principal))
  } catch (error) {
    if (!dependencies.isUniqueViolation(error)) throw error
    // A concurrent setup may have won the scoped unique constraint. Its key and
    // credential committed together; re-reading in a fresh transaction is the only
    // safe recovery and never leaves an orphan key from this rolled-back attempt.
    return await dependencies.transaction((trx) => ensureInsideTransaction(trx, scope, principal))
  }
}

function resolveEncryptionService(container: AwilixContainer): PublicBookingEncryptionService | null {
  try {
    return container.resolve('tenantEncryptionService') as PublicBookingEncryptionService
  } catch {
    return null
  }
}

export function createPublicBookingIdentityDependencies(
  em: EntityManager,
  container: AwilixContainer,
  encryptionMaps: ModuleEncryptionMap[] = defaultEncryptionMaps,
): PublicBookingIdentityDependencies {
  return {
    materializeEncryptionMaps: async (scope) => {
      // Dynamic because the supported helper lives in the entities CLI module, whose
      // unrelated command registrations pull ESM-only database tooling into Jest when
      // loaded eagerly. Production setup still resolves the exact installed export.
      const { upsertEncryptionMapSpecs } = await import('@open-mercato/core/modules/entities/cli')
      await upsertEncryptionMapSpecs(
        em.fork(),
        scope.tenantId,
        scope.organizationId,
        encryptionMaps,
      )
    },
    provisionPrincipal: async (scope) => await provisionExecutionPrincipal(container, scope, {
      principalKey: PUBLIC_BOOKING_PRINCIPAL_KEY,
      displayName: 'Public booking service',
      features: [...PUBLIC_BOOKING_PRINCIPAL_FEATURES],
      kind: 'service',
      namePrefix: 'public-booking',
      mergeFeatures: false,
    }),
    transaction: async <T>(run: (trx: PublicBookingIdentityTransaction) => Promise<T>) => (
      await em.fork().transactional(async (transactionEm) => {
        const adapter: PublicBookingIdentityTransaction = {
          findCredential: async (scope) => await transactionEm.findOne(ServiceCredential, {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            deletedAt: null,
          } as FilterQuery<ServiceCredential>),
          findApiKey: async ({ id, serviceUserId, roleId, scope }) => {
            const key = await transactionEm.findOne(ApiKey, {
              id,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              createdBy: serviceUserId,
              deletedAt: null,
            } as FilterQuery<ApiKey>)
            if (!key || key.rolesJson?.length !== 1 || key.rolesJson[0] !== roleId) return null
            return { id: key.id }
          },
          retireCredential: async (id) => {
            const existing = await transactionEm.findOne(ServiceCredential, { id })
            if (!existing) return
            existing.deletedAt = new Date()
            existing.updatedAt = new Date()
            transactionEm.persist(existing)
          },
          retireApiKey: async (id) => {
            const existing = await transactionEm.findOne(ApiKey, { id })
            if (!existing || existing.deletedAt) return
            existing.deletedAt = new Date()
            transactionEm.persist(existing)
          },
          createApiKey: async ({ serviceUserId, roleId, scope }) => {
            const created = await createApiKey(transactionEm, {
              name: 'Public booking service',
              description: 'Least-privilege key provisioned for anonymous appointment booking',
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              roles: [roleId],
              createdBy: serviceUserId,
            })
            return { id: created.record.id, secret: created.secret }
          },
          createCredential: async ({ serviceUserId, apiKeyId, secret, scope }) => {
            const encrypted = await encryptPublicBookingFields(
              'public_booking:service_credential',
              { apiKeySecret: secret },
              scope,
              resolveEncryptionService(container),
            )
            const now = new Date()
            const credential = transactionEm.create(ServiceCredential, {
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              serviceUserId,
              apiKeyId,
              apiKeySecret: encrypted.apiKeySecret,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            })
            transactionEm.persist(credential)
            await transactionEm.flush()
            return credential
          },
        }
        return await run(adapter)
      })
    ),
    isUniqueViolation: (error) => error instanceof UniqueConstraintViolationException,
  }
}

export async function provisionPublicBookingServiceIdentity(input: {
  em: EntityManager
  container: AwilixContainer
  scope: PublicBookingScope
}): Promise<PublicBookingCredentialRef> {
  return await ensurePublicBookingIdentity(
    createPublicBookingIdentityDependencies(input.em, input.container),
    input.scope,
  )
}

/** Scoped, decrypted read used only by the server-side public-request auth bridge. */
export async function readPublicBookingServiceSecret(
  em: EntityManager,
  scope: PublicBookingScope,
): Promise<string> {
  const credential = await findOneWithDecryption(
    em,
    ServiceCredential,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<ServiceCredential>,
    undefined,
    scope,
  )
  if (!credential?.apiKeySecret) {
    throw new CrudHttpError(503, {
      error: 'Public booking service identity is unavailable',
      code: 'service_identity_unavailable',
    })
  }
  return credential.apiKeySecret
}
