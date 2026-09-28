import { describe, expect, it, jest } from '@jest/globals'
import { POLANA_CATALOG_FIXTURES } from '../catalog-fixtures'
import {
  isPolanaProductFieldKey,
  planPolanaCatalog,
  seedPolanaCatalog,
  type CatalogBootstrapDependencies,
} from '../catalog-bootstrap'

const scope = { tenantId: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002' }

function emptyDependencies() {
  const execute = jest.fn(async (commandId: string, input: Record<string, unknown>) => {
    if (commandId === 'catalog.categories.create') return { categoryId: `category-${String(input.slug)}` }
    if (commandId === 'catalog.products.create') return { productId: `product-${String(input.sku)}` }
    if (commandId === 'catalog.variants.create') return { variantId: `variant-${String(input.sku)}` }
    return {}
  })
  const setProductFields = jest.fn(async (_recordId: string, _values: Record<string, string | number | null>) => undefined)
  return {
    dependencies: {
      ensureFields: jest.fn(async () => undefined),
      listCategories: jest.fn(async (): ReturnType<CatalogBootstrapDependencies['listCategories']> => []),
      listProducts: jest.fn(async (): ReturnType<CatalogBootstrapDependencies['listProducts']> => []),
      listVariants: jest.fn(async (): ReturnType<CatalogBootstrapDependencies['listVariants']> => []),
      listPrices: jest.fn(async (): ReturnType<CatalogBootstrapDependencies['listPrices']> => []),
      regularPriceKindId: jest.fn(async () => 'regular-kind'),
      restoreCategory: jest.fn(async () => undefined),
      execute,
      setProductFields,
    } satisfies CatalogBootstrapDependencies,
    execute,
    setProductFields,
  }
}

describe('Polana catalog bootstrap', () => {
  it('retains exactly the four Polana product custom fields', () => {
    expect(['session_details', 'price_max_pln', 'surcharge_amount_pln', 'pricing_note'].every(isPolanaProductFieldKey)).toBe(true)
    expect(isPolanaProductFieldKey('shoe_size')).toBe(false)
    expect(isPolanaProductFieldKey('service_schedule')).toBe(false)
    expect(isPolanaProductFieldKey('my_custom_field')).toBe(false)
  })

  it('creates four categories and exactly eight services, variants, and PLN prices', async () => {
    const { dependencies, execute, setProductFields } = emptyDependencies()
    const result = await seedPolanaCatalog(dependencies, scope)

    expect(result).toEqual({
      createdCategories: 4,
      createdProducts: 8,
      updatedProducts: 0,
      createdVariants: 8,
      updatedVariants: 0,
      createdPrices: 8,
      updatedPrices: 0,
    })
    expect(execute.mock.calls.filter(([id]) => id === 'catalog.products.create')).toHaveLength(8)
    expect(execute.mock.calls.filter(([id]) => id === 'catalog.products.create').every(([, input]) => input.defaultUnit === 'pc')).toBe(true)
    expect(execute.mock.calls.filter(([id]) => id === 'catalog.variants.create').every(([, input]) => input.organizationId === scope.organizationId && input.tenantId === scope.tenantId)).toBe(true)
    const prices = execute.mock.calls.filter(([id]) => id === 'catalog.prices.create').map(([, input]) => input)
    expect(prices.map((input) => [input.currencyCode, input.unitPriceGross])).toEqual(
      POLANA_CATALOG_FIXTURES.map((fixture) => ['PLN', fixture.pricePln]),
    )
    expect(setProductFields.mock.calls.map(([, values]) => Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== null),
    ))).toEqual(POLANA_CATALOG_FIXTURES.map((fixture) => fixture.customFields))
  })

  it('reports an exact zero-write dry-run plan', async () => {
    const { dependencies, execute } = emptyDependencies()
    await expect(planPolanaCatalog(dependencies, scope)).resolves.toEqual({
      categoriesToCreate: 4,
      productsToCreate: 8,
      productsToUpdate: 0,
      variantsToCreate: 8,
      variantsToUpdate: 0,
      pricesToCreate: 8,
      pricesToUpdate: 0,
    })
    expect(dependencies.ensureFields).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('reuses an existing category with the same stable slug when its display name differs', async () => {
    const { dependencies } = emptyDependencies()
    dependencies.listCategories.mockResolvedValue([{ id: 'diagnoses', name: 'Diagnozy', slug: 'diagnozy' }])
    await expect(planPolanaCatalog(dependencies, scope)).resolves.toEqual(expect.objectContaining({ categoriesToCreate: 3 }))
  })

  it('updates fixture-key matches without creating duplicates', async () => {
    const { dependencies, execute } = emptyDependencies()
    const categoryNames = [...new Set(POLANA_CATALOG_FIXTURES.map((fixture) => fixture.category))]
    dependencies.listCategories.mockResolvedValue(categoryNames.map((name, index) => ({ id: `category-${index}`, name })))
    dependencies.listProducts.mockResolvedValue(POLANA_CATALOG_FIXTURES.map((fixture) => ({ id: `product-${fixture.sku}`, sku: fixture.sku })))
    dependencies.listVariants.mockResolvedValue(POLANA_CATALOG_FIXTURES.map((fixture) => ({ id: `variant-${fixture.sku}`, sku: fixture.sku, productId: `product-${fixture.sku}` })))
    dependencies.listPrices.mockResolvedValue(POLANA_CATALOG_FIXTURES.map((fixture) => ({ id: `price-${fixture.sku}`, variantId: `variant-${fixture.sku}`, priceKindId: 'regular-kind', currencyCode: 'PLN' })))

    const result = await seedPolanaCatalog(dependencies, scope)

    expect(result).toEqual({ createdCategories: 0, createdProducts: 0, updatedProducts: 8, createdVariants: 0, updatedVariants: 8, createdPrices: 0, updatedPrices: 8 })
    expect(execute.mock.calls.some(([id]) => id.endsWith('.create'))).toBe(false)
  })

  it('fails closed before any lookup or write when scope is incomplete', async () => {
    const { dependencies, execute } = emptyDependencies()
    await expect(seedPolanaCatalog(dependencies, { ...scope, organizationId: '' })).rejects.toThrow('requires tenant and organization scope')
    expect(dependencies.ensureFields).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})
