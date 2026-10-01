import type { AwilixContainer } from 'awilix'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { E } from '@/.mercato/generated/entities.ids.generated'
import type { BootstrapScope } from './customer-bootstrap'

export type PolanaBookingFixture = {
  sku: string
  durationMinutes: number
  therapistSourceIds: readonly string[]
  resourceKeys: readonly string[]
}

export const POLANA_BOOKING_FIXTURES: readonly PolanaBookingFixture[] = [
  { sku: 'PP-DIAG-SI', durationMinutes: 60, therapistSourceIds: ['joanna-wieczorek', 'barbara-kowalczyk'], resourceKeys: ['sala-si'] },
  { sku: 'PP-DIAG-LOG', durationMinutes: 60, therapistSourceIds: ['elzbieta-sokolowska', 'aleksandra-nowakowska'], resourceKeys: ['gabinet-logopedy', 'gabinet-neurologopedii'] },
  { sku: 'PP-DIAG-PSY', durationMinutes: 60, therapistSourceIds: ['barbara-kowalczyk'], resourceKeys: ['gabinet-psychologa'] },
  { sku: 'PP-TER-LOG', durationMinutes: 50, therapistSourceIds: ['elzbieta-sokolowska', 'aleksandra-nowakowska'], resourceKeys: ['gabinet-logopedy', 'gabinet-neurologopedii'] },
  { sku: 'PP-REDIAG-LOG', durationMinutes: 50, therapistSourceIds: ['elzbieta-sokolowska', 'aleksandra-nowakowska'], resourceKeys: ['gabinet-logopedy', 'gabinet-neurologopedii'] },
  { sku: 'PP-TER-SI', durationMinutes: 50, therapistSourceIds: ['joanna-wieczorek', 'barbara-kowalczyk'], resourceKeys: ['sala-si'] },
  { sku: 'PP-TUS', durationMinutes: 60, therapistSourceIds: ['joanna-wieczorek', 'barbara-kowalczyk'], resourceKeys: ['sala-si'] },
  { sku: 'PP-KONS-PSY', durationMinutes: 50, therapistSourceIds: ['barbara-kowalczyk'], resourceKeys: ['gabinet-psychologa'] },
] as const

type ProductRow = { id: string; sku: string }
type ReferenceRow = { id: string; fixtureKey: string }

export type BookingBootstrapDependencies = {
  listProducts(scope: BootstrapScope, skus: string[]): Promise<ProductRow[]>
  listTherapists(scope: BootstrapScope, sourceIds: string[]): Promise<ReferenceRow[]>
  listResources(scope: BootstrapScope, resourceKeys: string[]): Promise<ReferenceRow[]>
  setProductFields(
    recordId: string,
    values: {
      booking_duration_minutes: number
      booking_team_member_ids: string[]
      booking_resource_ids: string[]
    },
    scope: BootstrapScope,
  ): Promise<void>
}

function assertScope(scope: BootstrapScope): void {
  if (!scope.tenantId || !scope.organizationId) {
    throw new Error('Polana booking bootstrap requires tenantId and organizationId')
  }
}

function exactIdMap(rows: ReferenceRow[], expected: readonly string[], label: string): Map<string, string> {
  const grouped = new Map<string, string[]>()
  for (const row of rows) {
    const ids = grouped.get(row.fixtureKey) ?? []
    ids.push(row.id)
    grouped.set(row.fixtureKey, ids)
  }
  const resolved = new Map<string, string>()
  for (const key of expected) {
    const ids = grouped.get(key) ?? []
    if (ids.length !== 1) {
      throw new Error(`Polana booking bootstrap requires exactly one ${label} for fixture key ${key}; found ${ids.length}`)
    }
    resolved.set(key, ids[0])
  }
  return resolved
}

export async function seedPolanaBookingDefaults(
  dependencies: BookingBootstrapDependencies,
  scope: BootstrapScope,
): Promise<{ updatedProducts: number }> {
  assertScope(scope)
  const skus = POLANA_BOOKING_FIXTURES.map((fixture) => fixture.sku)
  const therapistKeys = [...new Set(POLANA_BOOKING_FIXTURES.flatMap((fixture) => fixture.therapistSourceIds))]
  const resourceKeys = [...new Set(POLANA_BOOKING_FIXTURES.flatMap((fixture) => fixture.resourceKeys))]
  const [products, therapists, resources] = await Promise.all([
    dependencies.listProducts(scope, skus),
    dependencies.listTherapists(scope, therapistKeys),
    dependencies.listResources(scope, resourceKeys),
  ])
  const productIds = exactIdMap(
    products.map((product) => ({ id: product.id, fixtureKey: product.sku })),
    skus,
    'catalog product',
  )
  const therapistIds = exactIdMap(therapists, therapistKeys, 'therapist')
  const resourceIds = exactIdMap(resources, resourceKeys, 'resource')

  // Resolve the entire map before the first write. A missing or ambiguous fixture
  // therefore fails closed without leaving a partially configured catalogue.
  const writes = POLANA_BOOKING_FIXTURES.map((fixture) => ({
    productId: productIds.get(fixture.sku)!,
    values: {
      booking_duration_minutes: fixture.durationMinutes,
      booking_team_member_ids: fixture.therapistSourceIds.map((key) => therapistIds.get(key)!),
      booking_resource_ids: fixture.resourceKeys.map((key) => resourceIds.get(key)!),
    },
  }))
  for (const write of writes) {
    await dependencies.setProductFields(write.productId, write.values, scope)
  }
  return { updatedProducts: writes.length }
}

function text(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export function createBookingBootstrapDependencies(container: AwilixContainer): BookingBootstrapDependencies {
  const queryEngine = container.resolve<QueryEngine>('queryEngine')
  const dataEngine = container.resolve<DataEngine>('dataEngine')
  return {
    async listProducts(scope, skus) {
      const result = await queryEngine.query<Record<string, unknown>>(E.catalog.catalog_product, {
        fields: ['id', 'sku'],
        filters: { sku: { $in: skus } },
        page: { page: 1, pageSize: skus.length + 1 },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
      return result.items.flatMap((row) => {
        const id = text(row, 'id')
        const sku = text(row, 'sku')
        return id && sku ? [{ id, sku }] : []
      })
    },
    async listTherapists(scope, sourceIds) {
      const result = await queryEngine.query<Record<string, unknown>>(E.staff.staff_team_member, {
        fields: ['id', 'is_active', 'deleted_at', 'cf:polana_source_id'],
        filters: {
          'cf:polana_source_id': { $in: sourceIds },
          is_active: true,
          deleted_at: null,
        },
        page: { page: 1, pageSize: sourceIds.length + 1 },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
      return result.items.flatMap((row) => {
        const id = text(row, 'id')
        const fixtureKey = text(row, 'cf:polana_source_id', 'cf_polana_source_id')
        return id && fixtureKey ? [{ id, fixtureKey }] : []
      })
    },
    async listResources(scope, resourceKeys) {
      const result = await queryEngine.query<Record<string, unknown>>(E.resources.resources_resource, {
        fields: ['id', 'is_active', 'deleted_at', 'cf:polana_resource_key'],
        filters: {
          'cf:polana_resource_key': { $in: resourceKeys },
          is_active: true,
          deleted_at: null,
        },
        page: { page: 1, pageSize: resourceKeys.length + 1 },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
      return result.items.flatMap((row) => {
        const id = text(row, 'id')
        const fixtureKey = text(row, 'cf:polana_resource_key', 'cf_polana_resource_key')
        return id && fixtureKey ? [{ id, fixtureKey }] : []
      })
    },
    setProductFields: async (recordId, values, scope) => dataEngine.setCustomFields({
      entityId: E.catalog.catalog_product,
      recordId,
      ...scope,
      values,
      notify: true,
    }),
  }
}
