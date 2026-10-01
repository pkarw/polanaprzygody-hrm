import { describe, expect, it, jest } from '@jest/globals'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import {
  resolvePublicBookingRequestContext,
  type PublicBookingAuthDependencies,
} from '../lib/publicAuth'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}
const serviceUserId = '33333333-3333-4333-8333-333333333333'
const apiKeyId = '44444444-4444-4444-8444-444444444444'

function dependencies(overrides: Partial<PublicBookingAuthDependencies> = {}): PublicBookingAuthDependencies {
  return {
    locateScope: jest.fn(async () => ({ scope, serviceUserId, apiKeyId })),
    readSecret: jest.fn(async () => 'secret-value-never-returned'),
    resolve: jest.fn<(request: Request) => ReturnType<PublicBookingAuthDependencies['resolve']>>(async (request) => {
      expect(request.headers.get('x-api-key')).toBe('secret-value-never-returned')
      return {
        status: 'authenticated' as const,
        auth: {
          sub: `api_key:${apiKeyId}`,
          userId: serviceUserId,
          keyId: apiKeyId,
          tenantId: scope.tenantId,
          orgId: scope.organizationId,
          isApiKey: true,
        },
      }
    }),
    ...overrides,
  }
}

describe('public booking auth bridge', () => {
  it('returns only verified scope and auth, never the decrypted secret', async () => {
    const result = await resolvePublicBookingRequestContext({} as never, {} as never, dependencies())

    expect(result.scope).toEqual(scope)
    expect(result.auth.userId).toBe(serviceUserId)
    expect(JSON.stringify(result)).not.toContain('secret-value')
  })

  it('fails closed when the resolved key crosses scope or identity', async () => {
    const mismatched = dependencies({
      resolve: async () => ({
        status: 'authenticated',
        auth: {
          sub: `api_key:${apiKeyId}`,
          userId: serviceUserId,
          keyId: apiKeyId,
          tenantId: scope.tenantId,
          orgId: '55555555-5555-4555-8555-555555555555',
          isApiKey: true,
        },
      }),
    })

    await expect(resolvePublicBookingRequestContext({} as never, {} as never, mismatched))
      .rejects.toMatchObject({ status: 503 } satisfies Partial<CrudHttpError>)
  })

  it('normalizes credential lookup and auth failures to a safe 503', async () => {
    const missing = dependencies({ locateScope: async () => { throw new Error('none or ambiguous') } })

    await expect(resolvePublicBookingRequestContext({} as never, {} as never, missing))
      .rejects.toMatchObject({
        status: 503,
        body: { error: 'Public booking is temporarily unavailable', code: 'service_identity_unavailable' },
      } satisfies Partial<CrudHttpError>)
  })
})
