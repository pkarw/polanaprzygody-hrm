import { describe, expect, it, jest } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'
import {
  DEFAULT_INSTALL_ORGANIZATION_NAME,
  POLANA_ORGANIZATION_NAME,
  planPolanaOrganization,
  seedPolanaOrganization,
} from '../organization-bootstrap'

const scope = { tenantId: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002' }

type OrgRow = { id: string; name: string; slug: string | null; parentId: string | null; childIds: string[] }
type TenantRow = { id: string; name: string; updatedAt?: Date }

function harness(state: { organization?: OrgRow | null; tenant?: TenantRow | null }) {
  const organization = state.organization === undefined
    ? { id: scope.organizationId, name: DEFAULT_INSTALL_ORGANIZATION_NAME, slug: 'acme-corp', parentId: null, childIds: [] }
    : state.organization
  const tenant = state.tenant === undefined
    ? { id: scope.tenantId, name: DEFAULT_INSTALL_ORGANIZATION_NAME }
    : state.tenant
  const flush = jest.fn(async () => undefined)
  const em = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === Organization) return organization
      if (entity === Tenant) return tenant
      return null
    }),
    persist: jest.fn(),
    flush,
  } as unknown as EntityManager
  const execute = jest.fn(async (_commandId: string, _payload: { input: Record<string, unknown> }) => ({ result: {} }))
  const container = { resolve: jest.fn(() => ({ execute })) } as unknown as AwilixContainer
  return { em, container, execute, flush, organization, tenant }
}

describe('Polana organization bootstrap', () => {
  it('renames the placeholder organization, its derived slug, and the tenant', async () => {
    const { em, container, execute, tenant } = harness({})

    const summary = await seedPolanaOrganization(em, container, scope)

    expect(summary).toEqual({ renamedOrganization: true, renamedOrganizationSlug: true, renamedTenant: true })
    expect(execute).toHaveBeenCalledWith('directory.organizations.update', expect.objectContaining({
      input: expect.objectContaining({
        id: scope.organizationId,
        tenantId: scope.tenantId,
        name: POLANA_ORGANIZATION_NAME,
        slug: 'polana-przygody',
        parentId: null,
        childIds: [],
      }),
    }))
    expect(tenant?.name).toBe(POLANA_ORGANIZATION_NAME)
  })

  it('echoes the existing org tree back so the update never unparents children', async () => {
    const { em, container, execute } = harness({
      organization: { id: scope.organizationId, name: DEFAULT_INSTALL_ORGANIZATION_NAME, slug: 'acme-corp', parentId: 'parent-1', childIds: ['child-1', 'child-2'] },
    })

    await seedPolanaOrganization(em, container, scope)

    const input = execute.mock.calls[0]![1]
    expect(input.input.parentId).toBe('parent-1')
    expect(input.input.childIds).toEqual(['child-1', 'child-2'])
  })

  it('leaves a hand-picked slug alone while still renaming the organization', async () => {
    const { em, container, execute } = harness({
      organization: { id: scope.organizationId, name: DEFAULT_INSTALL_ORGANIZATION_NAME, slug: 'klinika', parentId: null, childIds: [] },
    })

    const summary = await seedPolanaOrganization(em, container, scope)

    expect(summary.renamedOrganization).toBe(true)
    expect(summary.renamedOrganizationSlug).toBe(false)
    const input = execute.mock.calls[0]![1]
    expect(input.input).not.toHaveProperty('slug')
  })

  it('never touches a workspace an operator named themselves', async () => {
    const { em, container, execute, flush } = harness({
      organization: { id: scope.organizationId, name: 'Klinika Brzoza', slug: 'klinika-brzoza', parentId: null, childIds: [] },
      tenant: { id: scope.tenantId, name: 'Klinika Brzoza' },
    })

    const summary = await seedPolanaOrganization(em, container, scope)

    expect(summary).toEqual({ renamedOrganization: false, renamedOrganizationSlug: false, renamedTenant: false })
    expect(execute).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

  it('reports a zero-write plan', async () => {
    const { em } = harness({})

    await expect(planPolanaOrganization(em, scope)).resolves.toEqual({
      organizationRename: { from: DEFAULT_INSTALL_ORGANIZATION_NAME, to: POLANA_ORGANIZATION_NAME },
      organizationSlugRename: { from: 'acme-corp', to: 'polana-przygody' },
      tenantRename: { from: DEFAULT_INSTALL_ORGANIZATION_NAME, to: POLANA_ORGANIZATION_NAME },
    })
  })

  it('refuses to run without a trusted tenant and organization', async () => {
    const { em, container } = harness({})
    await expect(seedPolanaOrganization(em, container, { tenantId: '', organizationId: scope.organizationId }))
      .rejects.toThrow('requires tenantId and organizationId')
  })
})
