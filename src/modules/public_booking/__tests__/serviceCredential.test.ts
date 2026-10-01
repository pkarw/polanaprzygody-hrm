import { describe, expect, it, jest } from '@jest/globals'
import {
  PUBLIC_BOOKING_PRINCIPAL_FEATURES,
  ensurePublicBookingIdentity,
  type PublicBookingCredentialRef,
  type PublicBookingIdentityDependencies,
  type PublicBookingIdentityTransaction,
} from '../lib/serviceCredential'
import type { PublicBookingScope } from '../lib/commandSupport'

function memoryDependencies() {
  const credentials = new Map<string, PublicBookingCredentialRef>()
  const keys = new Map<string, { serviceUserId: string; roleId: string }>()
  let keySequence = 0
  const materialized: string[] = []

  const dependencies: PublicBookingIdentityDependencies = {
    materializeEncryptionMaps: jest.fn<(scope: PublicBookingScope) => Promise<void>>(async (scope) => {
      materialized.push(`${scope.tenantId}:${scope.organizationId}`)
    }),
    provisionPrincipal: jest.fn<(scope: PublicBookingScope) => Promise<{ userId: string; roleId: string }>>(async (scope) => ({
      userId: `user-${scope.organizationId}`,
      roleId: `role-${scope.organizationId}`,
    })),
    transaction: async <T>(run: (trx: PublicBookingIdentityTransaction) => Promise<T>) => {
      const trx: PublicBookingIdentityTransaction = {
        findCredential: async (scope) => credentials.get(scopeKey(scope)) ?? null,
        findApiKey: async ({ id, serviceUserId, roleId }) => {
          const key = keys.get(id)
          return key?.serviceUserId === serviceUserId && key.roleId === roleId ? { id } : null
        },
        retireCredential: async (id) => {
          for (const [scope, credential] of credentials) {
            if (credential.id === id) credentials.delete(scope)
          }
        },
        retireApiKey: async (id) => { keys.delete(id) },
        createApiKey: async ({ serviceUserId, roleId }) => {
          keySequence += 1
          const id = `key-${keySequence}`
          keys.set(id, { serviceUserId, roleId })
          return { id, secret: `secret-${keySequence}` }
        },
        createCredential: async ({ serviceUserId, apiKeyId, scope }) => {
          const credential = { id: `credential-${apiKeyId}`, serviceUserId, apiKeyId }
          credentials.set(scopeKey(scope), credential)
          return credential
        },
      }
      return await run(trx)
    },
    isUniqueViolation: () => false,
  }
  return { dependencies, credentials, keys, materialized, keyCount: () => keySequence }
}

function scopeKey(scope: PublicBookingScope): string {
  return `${scope.tenantId}:${scope.organizationId}`
}

describe('public booking service identity', () => {
  it('pins the service principal to exactly the six approved features', () => {
    expect(PUBLIC_BOOKING_PRINCIPAL_FEATURES).toEqual([
      'catalog.products.view',
      'customers.people.manage',
      'patient.patients.manage',
      'patient.visits.manage',
      'resources.view',
      'staff.view',
    ])
  })

  it('is idempotent within a scope and isolated across two scopes', async () => {
    const state = memoryDependencies()
    const firstScope = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    }
    const secondScope = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '33333333-3333-4333-8333-333333333333',
    }

    const first = await ensurePublicBookingIdentity(state.dependencies, firstScope)
    const replay = await ensurePublicBookingIdentity(state.dependencies, firstScope)
    const second = await ensurePublicBookingIdentity(state.dependencies, secondScope)

    expect(replay).toEqual(first)
    expect(second).not.toEqual(first)
    expect(state.credentials.size).toBe(2)
    expect(state.keys.size).toBe(2)
    expect(state.keyCount()).toBe(2)
    expect(state.materialized).toEqual([
      scopeKey(firstScope),
      scopeKey(firstScope),
      scopeKey(secondScope),
    ])
  })

  it('rotates a credential whose referenced key no longer exists', async () => {
    const state = memoryDependencies()
    const scope = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    }
    const first = await ensurePublicBookingIdentity(state.dependencies, scope)
    state.keys.delete(first.apiKeyId)

    const replacement = await ensurePublicBookingIdentity(state.dependencies, scope)

    expect(replacement.apiKeyId).not.toBe(first.apiKeyId)
    expect(state.credentials.get(scopeKey(scope))).toEqual(replacement)
    expect(state.keys.size).toBe(1)
  })
})
