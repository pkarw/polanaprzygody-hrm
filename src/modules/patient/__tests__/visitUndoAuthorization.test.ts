import { describe, expect, it, jest } from '@jest/globals'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { authorizeSnapshotReferences } from '../commands/visits'

describe('visit historical undo authorization', () => {
  it.each(['update', 'delete'])('%s undo does not re-resolve inactive host references', async () => {
    const userHasAllFeatures = jest.fn(async () => true)
    const resolve = jest.fn((token: string) => {
      if (token === 'rbacService') return { userHasAllFeatures }
      throw new Error(`unexpected dependency: ${token}`)
    })
    const ctx = {
      container: { resolve },
      auth: { sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1' },
      selectedOrganizationId: 'org-1',
      organizationScope: null,
      organizationIds: ['org-1'],
    } as unknown as CommandRuntimeContext

    await expect(authorizeSnapshotReferences(
      ctx,
      { tenantId: 'tenant-1', organizationId: 'org-1' },
      {
        id: 'visit-1',
        patientId: 'patient-1',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        teamMemberId: 'inactive-team-member',
        resourceId: 'inactive-resource',
        services: [{ productId: 'inactive-product' }],
      } as never,
    )).resolves.toBeUndefined()

    expect(resolve).not.toHaveBeenCalledWith('patientReferenceService')
    expect(userHasAllFeatures).toHaveBeenCalledTimes(4)
  })
})
