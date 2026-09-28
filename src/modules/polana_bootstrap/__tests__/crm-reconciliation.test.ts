import { describe, expect, it, jest } from '@jest/globals'
import type { CustomerBootstrapDependencies } from '../customer-bootstrap'
import { POLANA_PERSON_FIXTURES } from '../fixtures'
import {
  LEGACY_CUSTOMER_EMAILS,
  planCrmReconciliation,
  reconcileCrmCustomers,
} from '../crm-reconciliation'

const scope = { tenantId: 'tenant-1', organizationId: 'organization-1' }

function makeDependencies() {
  const people = [
    ...LEGACY_CUSTOMER_EMAILS.map((primaryEmail, index) => ({
      id: `legacy-${index}`, kind: 'person', primaryEmail, ...scope,
    })),
    { id: 'unrelated', kind: 'person', primaryEmail: 'patient@example.test', ...scope },
  ]
  const execute = jest.fn(async (_commandId: string, _input: Record<string, unknown>) => ({} as never))
  const dependencies = {
    listPeople: jest.fn(async () => people),
    listAddresses: jest.fn(async () => []),
    execute,
  } satisfies CustomerBootstrapDependencies
  return { dependencies, execute }
}

describe('CRM reconciliation', () => {
  it('dry-runs the six exact installed fixtures without writing', async () => {
    const { dependencies, execute } = makeDependencies()
    const result = await reconcileCrmCustomers(dependencies, scope)

    expect(result.plan.legacyMatches).toHaveLength(6)
    expect(result.plan.untouchedPeople).toBe(1)
    expect(result.bootstrap).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })

  it('fails closed without complete scope', async () => {
    const { dependencies, execute } = makeDependencies()
    await expect(planCrmReconciliation(dependencies, { ...scope, tenantId: '' })).rejects.toThrow('explicit tenant')
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses a target-email collision before writing', async () => {
    const { dependencies, execute } = makeDependencies()
    dependencies.listPeople.mockResolvedValue([
      ...(await dependencies.listPeople()),
      { id: 'collision', kind: 'person', primaryEmail: POLANA_PERSON_FIXTURES[0]!.email, ...scope },
    ])
    await expect(reconcileCrmCustomers(dependencies, scope, { execute: true })).rejects.toThrow('conflict')
    expect(execute).not.toHaveBeenCalled()
  })

  it('updates only known fixtures before running the idempotent Polana bootstrap', async () => {
    const { dependencies, execute } = makeDependencies()
    await reconcileCrmCustomers(dependencies, scope, { execute: true })

    const updates = execute.mock.calls.filter(([command]) => command === 'customers.people.update')
    expect(updates).toHaveLength(6)
    expect(updates.map(([, input]) => input.id)).toEqual(LEGACY_CUSTOMER_EMAILS.map((_, index) => `legacy-${index}`))
    expect(updates.some(([, input]) => input.id === 'unrelated')).toBe(false)
  })
})
