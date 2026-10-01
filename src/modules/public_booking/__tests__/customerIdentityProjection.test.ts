import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  backfillCustomerIdentityProjections,
  findCustomerByProjectedIdentity,
  reconcileCustomerIdentityProjection,
} from '../lib/customerIdentityProjection'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}
const otherScope = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  organizationId: '44444444-4444-4444-8444-444444444444',
}
const customerId = '55555555-5555-4555-8555-555555555555'

function customer(overrides: Partial<CustomerEntity> = {}): CustomerEntity {
  return {
    id: customerId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    kind: 'person',
    isActive: true,
    deletedAt: null,
    primaryEmail: 'anna@example.com',
    primaryPhone: '+48 790 512 258',
    ...overrides,
  } as CustomerEntity
}

function createEm(projections: Array<{ customerEntityId: string }> = []) {
  const find = jest.fn<(
    entity: unknown,
    where: unknown,
    options?: unknown,
  ) => Promise<Array<{ customerEntityId: string }>>>(async () => projections)
  const nativeDelete = jest.fn<(entity: unknown, where: unknown) => Promise<number>>(async () => 1)
  const upsert = jest.fn<(
    entity: unknown,
    data: unknown,
    options?: unknown,
  ) => Promise<unknown>>(async (_entity, data) => data)
  return {
    em: { find, nativeDelete, upsert } as unknown as EntityManager,
    find,
    nativeDelete,
    upsert,
  }
}

describe('public booking customer identity projection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('matches one customer without decrypting 600 unrelated customer rows', async () => {
    const harness = createEm([{ customerEntityId: customerId }])
    jest.mocked(findWithDecryption).mockResolvedValue([customer()] as never)

    await expect(findCustomerByProjectedIdentity(harness.em, scope, {
      email: ' ANNA@EXAMPLE.COM ',
      phone: '+48 790 512 258',
    })).resolves.toBe(customerId)

    expect(harness.find).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }), expect.objectContaining({ limit: 101 }))
    const decryptCall = (jest.mocked(findWithDecryption).mock.calls as unknown[][])[0]!
    expect(decryptCall[0]).toBe(harness.em)
    expect(decryptCall[2]).toEqual(expect.objectContaining({ id: { $in: [customerId] }, ...scope }))
    expect(decryptCall[3]).toEqual(expect.objectContaining({ limit: 101 }))
    expect(decryptCall[4]).toEqual(scope)
    expect(JSON.stringify(decryptCall[2])).not.toContain('$ne')
  })

  it('binds lookup hashes and reads to the exact tenant and organization scope', async () => {
    const previousPepper = process.env.LOOKUP_HASH_PEPPER
    process.env.LOOKUP_HASH_PEPPER = 'test-only-customer-identity-pepper'
    const first = createEm()
    const second = createEm()
    try {
      await findCustomerByProjectedIdentity(first.em, scope, { email: 'anna@example.com' })
      await findCustomerByProjectedIdentity(second.em, otherScope, { email: 'anna@example.com' })

      const firstWhere = first.find.mock.calls[0]![1] as Record<string, unknown>
      const secondWhere = second.find.mock.calls[0]![1] as Record<string, unknown>
      expect(firstWhere).toEqual(expect.objectContaining(scope))
      expect(secondWhere).toEqual(expect.objectContaining(otherScope))
      expect(JSON.stringify(firstWhere.$or)).not.toBe(JSON.stringify(secondWhere.$or))
    } finally {
      if (previousPepper === undefined) delete process.env.LOOKUP_HASH_PEPPER
      else process.env.LOOKUP_HASH_PEPPER = previousPepper
    }
  })

  it('fails closed when one submitted identity resolves to multiple active customers', async () => {
    const secondId = '66666666-6666-4666-8666-666666666666'
    const harness = createEm([{ customerEntityId: customerId }, { customerEntityId: secondId }])
    jest.mocked(findWithDecryption).mockResolvedValue([
      customer(),
      customer({ id: secondId }),
    ] as never)

    await expect(findCustomerByProjectedIdentity(harness.em, scope, {
      email: 'anna@example.com',
    })).rejects.toThrow('Public booking is temporarily unavailable')
  })

  it('upserts only keyed digests and removes projections for deleted people', async () => {
    const harness = createEm()
    jest.mocked(findOneWithDecryption).mockResolvedValue(customer() as never)

    await reconcileCustomerIdentityProjection(harness.em, scope, customerId)
    expect(harness.upsert).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      ...scope,
      customerEntityId: customerId,
      emailHash: expect.not.stringContaining('anna@example.com'),
      phoneHash: expect.not.stringContaining('790512258'),
    }), expect.objectContaining({
      onConflictFields: ['tenantId', 'organizationId', 'customerEntityId'],
    }))

    jest.mocked(findOneWithDecryption).mockResolvedValue(customer({ deletedAt: new Date() }) as never)
    await reconcileCustomerIdentityProjection(harness.em, scope, customerId)
    expect(harness.nativeDelete).toHaveBeenCalledWith(expect.any(Function), {
      ...scope,
      customerEntityId: customerId,
    })
  })

  it('backfills every existing person in bounded pages, including populations over 500', async () => {
    const harness = createEm()
    const ids = Array.from({ length: 501 }, (_, index) => `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`)
    let page = 0
    jest.mocked(findWithDecryption).mockImplementation(async () => {
      const start = page * 200
      page += 1
      return ids.slice(start, start + 200).map((id) => customer({ id })) as never
    })
    jest.mocked(findOneWithDecryption).mockImplementation(async (_em, _entity, where) => (
      customer({ id: String((where as { id: string }).id) }) as never
    ))

    await backfillCustomerIdentityProjections(harness.em, scope)

    expect(findWithDecryption).toHaveBeenCalledTimes(3)
    expect(findOneWithDecryption).toHaveBeenCalledTimes(501)
    expect(harness.upsert).toHaveBeenCalledTimes(501)
  })
})
