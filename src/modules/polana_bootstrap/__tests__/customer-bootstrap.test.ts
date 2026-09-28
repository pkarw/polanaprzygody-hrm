import { describe, expect, it, jest } from '@jest/globals'
import { POLANA_PERSON_FIXTURES } from '../fixtures'
import {
  seedPolanaCustomers,
  type BootstrapScope,
  type CustomerBootstrapDependencies,
} from '../customer-bootstrap'

const scope: BootstrapScope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
}

function dependencies(
  people: Awaited<ReturnType<CustomerBootstrapDependencies['listPeople']>> = [],
  addresses: Awaited<ReturnType<CustomerBootstrapDependencies['listAddresses']>> = [],
) {
  const execute = jest.fn(async (commandId: string, input: Record<string, unknown>) => {
    if (commandId === 'customers.people.create') {
      return { entityId: `created-${String(input.primaryEmail)}` } as never
    }
    return {} as never
  })
  return {
    deps: {
      listPeople: jest.fn(async () => people),
      listAddresses: jest.fn(async () => addresses),
      execute,
    } satisfies CustomerBootstrapDependencies,
    execute,
  }
}

describe('seedPolanaCustomers', () => {
  it('creates the exact ten scoped people and addresses in an empty scope', async () => {
    const { deps, execute } = dependencies()

    const result = await seedPolanaCustomers(deps, scope)

    expect(result).toEqual({
      createdPeople: 10,
      updatedPeople: 0,
      createdAddresses: 10,
      updatedAddresses: 0,
    })
    expect(execute).toHaveBeenCalledTimes(20)
    const createPeople = execute.mock.calls.filter(([commandId]) => commandId === 'customers.people.create')
    expect(createPeople).toHaveLength(10)
    expect(createPeople.map(([, input]) => input.primaryEmail)).toEqual(
      POLANA_PERSON_FIXTURES.map((fixture) => fixture.email),
    )
    for (const [, input] of execute.mock.calls) {
      expect(input).toEqual(expect.objectContaining(scope))
    }
  })

  it('updates fixture-key matches without creating duplicates', async () => {
    const people = POLANA_PERSON_FIXTURES.map((fixture, index) => ({
      id: `person-${index}`,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      kind: 'person',
      primaryEmail: fixture.email,
    }))
    const addresses = people.map((person, index) => ({
      id: `address-${index}`,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      entity: { id: person.id },
    }))
    const { deps, execute } = dependencies(people, addresses)

    const result = await seedPolanaCustomers(deps, scope)

    expect(result).toEqual({
      createdPeople: 0,
      updatedPeople: 10,
      createdAddresses: 0,
      updatedAddresses: 10,
    })
    expect(execute.mock.calls.some(([commandId]) => commandId === 'customers.people.create')).toBe(false)
    expect(execute.mock.calls.some(([commandId]) => commandId === 'customers.addresses.create')).toBe(false)
  })

  it('fails closed when either scope identifier is missing', async () => {
    const { deps, execute } = dependencies()

    await expect(seedPolanaCustomers(deps, { ...scope, organizationId: '' })).rejects.toThrow(
      'requires tenant and organization scope',
    )
    expect(execute).not.toHaveBeenCalled()
  })
})
