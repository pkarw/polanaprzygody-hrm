import { describe, expect, it, jest } from '@jest/globals'
import {
  POLANA_BOOKING_FIXTURES,
  seedPolanaBookingDefaults,
  type BookingBootstrapDependencies,
} from '../booking-bootstrap'

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
}

function dependenciesFor(overrides: Partial<BookingBootstrapDependencies> = {}) {
  const setProductFields = jest.fn<BookingBootstrapDependencies['setProductFields']>(async () => undefined)
  const dependencies: BookingBootstrapDependencies = {
    listProducts: async (currentScope, skus) => skus.map((sku) => ({
      id: `${currentScope.organizationId}:product:${sku}`,
      sku,
    })),
    listTherapists: async (currentScope, sourceIds) => sourceIds.map((fixtureKey) => ({
      id: `${currentScope.organizationId}:therapist:${fixtureKey}`,
      fixtureKey,
    })),
    listResources: async (currentScope, resourceKeys) => resourceKeys.map((fixtureKey) => ({
      id: `${currentScope.organizationId}:resource:${fixtureKey}`,
      fixtureKey,
    })),
    setProductFields,
    ...overrides,
  }
  return { dependencies, setProductFields }
}

describe('Polana public-booking defaults', () => {
  it('writes the exact versioned SKU mapping and is idempotent on rerun', async () => {
    const { dependencies, setProductFields } = dependenciesFor()
    await expect(seedPolanaBookingDefaults(dependencies, scope)).resolves.toEqual({ updatedProducts: 8 })
    await expect(seedPolanaBookingDefaults(dependencies, scope)).resolves.toEqual({ updatedProducts: 8 })

    expect(setProductFields).toHaveBeenCalledTimes(16)
    expect(setProductFields.mock.calls.slice(0, 8).map(([recordId, values]) => ({ recordId, values })))
      .toEqual(POLANA_BOOKING_FIXTURES.map((fixture) => ({
        recordId: `${scope.organizationId}:product:${fixture.sku}`,
        values: {
          booking_duration_minutes: fixture.durationMinutes,
          booking_team_member_ids: fixture.therapistSourceIds.map((key) => `${scope.organizationId}:therapist:${key}`),
          booking_resource_ids: fixture.resourceKeys.map((key) => `${scope.organizationId}:resource:${key}`),
        },
      })))
  })

  it('resolves two scopes independently without reusing relation ids', async () => {
    const { dependencies, setProductFields } = dependenciesFor()
    const second = { ...scope, organizationId: '00000000-0000-4000-8000-000000000003' }
    await seedPolanaBookingDefaults(dependencies, scope)
    await seedPolanaBookingDefaults(dependencies, second)
    const firstIds = JSON.stringify(setProductFields.mock.calls.slice(0, 8))
    const secondIds = JSON.stringify(setProductFields.mock.calls.slice(8))
    expect(firstIds).toContain(scope.organizationId)
    expect(firstIds).not.toContain(second.organizationId)
    expect(secondIds).toContain(second.organizationId)
    expect(secondIds).not.toContain(scope.organizationId)
  })

  it('fails closed before writing when a stable fixture key is missing or ambiguous', async () => {
    const missing = dependenciesFor({ listResources: async () => [] })
    await expect(seedPolanaBookingDefaults(missing.dependencies, scope))
      .rejects.toThrow('requires exactly one resource')
    expect(missing.setProductFields).not.toHaveBeenCalled()

    const duplicate = dependenciesFor({
      listTherapists: async (_scope, sourceIds) => sourceIds.flatMap((fixtureKey, index) => (
        index === 0
          ? [{ id: `a:${fixtureKey}`, fixtureKey }, { id: `b:${fixtureKey}`, fixtureKey }]
          : [{ id: `a:${fixtureKey}`, fixtureKey }]
      )),
    })
    await expect(seedPolanaBookingDefaults(duplicate.dependencies, scope))
      .rejects.toThrow('found 2')
    expect(duplicate.setProductFields).not.toHaveBeenCalled()
  })

  it('rejects incomplete trusted scope before any lookup', async () => {
    const { dependencies, setProductFields } = dependenciesFor()
    await expect(seedPolanaBookingDefaults(dependencies, { ...scope, tenantId: '' }))
      .rejects.toThrow('requires tenantId and organizationId')
    expect(setProductFields).not.toHaveBeenCalled()
  })
})
