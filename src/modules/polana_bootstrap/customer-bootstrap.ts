import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CommandBus, type CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { POLANA_PERSON_FIXTURES, type PolanaPersonFixture } from './fixtures'

export type BootstrapScope = {
  tenantId: string
  organizationId: string
}

export type CustomerEntityRecord = {
  id: string
  tenantId: string
  organizationId: string
  kind: string
  primaryEmail?: string | null
}

export type CustomerAddressRecord = {
  id: string
  tenantId: string
  organizationId: string
  entity: string | { id: string }
}

type EntityClass<T> = abstract new (...args: never[]) => T

export type CustomerBootstrapDependencies = {
  listPeople(scope: BootstrapScope): Promise<CustomerEntityRecord[]>
  listAddresses(scope: BootstrapScope): Promise<CustomerAddressRecord[]>
  execute(commandId: string, input: Record<string, unknown>, scope: BootstrapScope): Promise<unknown>
}

export type CustomerBootstrapSummary = {
  createdPeople: number
  updatedPeople: number
  createdAddresses: number
  updatedAddresses: number
}

function addressEntityId(address: CustomerAddressRecord): string {
  return typeof address.entity === 'string' ? address.entity : address.entity.id
}

export function personInput(fixture: PolanaPersonFixture, scope: BootstrapScope): Record<string, unknown> {
  return {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    displayName: `${fixture.firstName} ${fixture.lastName}`,
    firstName: fixture.firstName,
    lastName: fixture.lastName,
    primaryEmail: fixture.email,
    status: 'active',
    lifecycleStage: 'customer',
    source: 'other',
    timezone: 'Europe/Warsaw',
    isActive: true,
  }
}

function addressInput(
  fixture: PolanaPersonFixture,
  entityId: string,
  scope: BootstrapScope,
): Record<string, unknown> {
  return {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    entityId,
    name: 'Adres domowy',
    purpose: 'home',
    ...fixture.address,
    isPrimary: true,
  }
}

export async function seedPolanaCustomers(
  dependencies: CustomerBootstrapDependencies,
  scope: BootstrapScope,
): Promise<CustomerBootstrapSummary> {
  if (!scope.tenantId || !scope.organizationId) {
    throw new Error('[internal] Polana bootstrap requires tenant and organization scope')
  }

  const people = await dependencies.listPeople(scope)
  const addresses = await dependencies.listAddresses(scope)
  const peopleByEmail = new Map(
    people
      .filter((person) => typeof person.primaryEmail === 'string')
      .map((person) => [person.primaryEmail!.trim().toLowerCase(), person]),
  )
  const addressByEntityId = new Map(addresses.map((address) => [addressEntityId(address), address]))
  const summary: CustomerBootstrapSummary = {
    createdPeople: 0,
    updatedPeople: 0,
    createdAddresses: 0,
    updatedAddresses: 0,
  }

  for (const fixture of POLANA_PERSON_FIXTURES) {
    const existingPerson = peopleByEmail.get(fixture.email)
    let entityId: string
    if (existingPerson) {
      await dependencies.execute('customers.people.update', {
        id: existingPerson.id,
        ...personInput(fixture, scope),
      }, scope)
      entityId = existingPerson.id
      summary.updatedPeople += 1
    } else {
      const created = await dependencies.execute(
        'customers.people.create',
        personInput(fixture, scope),
        scope,
      ) as { entityId: string }
      entityId = created.entityId
      summary.createdPeople += 1
    }

    const existingAddress = addressByEntityId.get(entityId)
    if (existingAddress) {
      await dependencies.execute('customers.addresses.update', {
        id: existingAddress.id,
        ...addressInput(fixture, entityId, scope),
      }, scope)
      summary.updatedAddresses += 1
    } else {
      await dependencies.execute('customers.addresses.create', addressInput(fixture, entityId, scope), scope)
      summary.createdAddresses += 1
    }
  }

  return summary
}

function commandContext(container: AwilixContainer, scope: BootstrapScope): CommandRuntimeContext {
  return {
    container,
    auth: {
      sub: 'system:polana_bootstrap',
      userId: 'system:polana_bootstrap',
      tenantId: scope.tenantId,
      orgId: scope.organizationId,
    },
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    syncOrigin: 'polana_bootstrap:setup',
    systemActor: true,
  }
}

export function createCustomerBootstrapDependencies(
  em: EntityManager,
  container: AwilixContainer,
): CustomerBootstrapDependencies {
  const customerEntity = container.resolve<EntityClass<CustomerEntityRecord>>('CustomerEntity')
  const customerAddress = container.resolve<EntityClass<CustomerAddressRecord>>('CustomerAddress')
  const commandBus = container.resolve<CommandBus>('commandBus')

  return {
    listPeople: async (scope) => findWithDecryption(
      em,
      customerEntity,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        kind: 'person',
        deletedAt: null,
      },
      undefined,
      scope,
    ),
    listAddresses: async (scope) => findWithDecryption(
      em,
      customerAddress,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      },
      { populate: ['entity'] },
      scope,
    ),
    execute: async (commandId: string, input: Record<string, unknown>, scope: BootstrapScope) => {
      const envelope = await commandBus.execute<Record<string, unknown>, unknown>(commandId, {
        input,
        ctx: commandContext(container, scope),
      })
      return envelope.result
    },
  }
}
