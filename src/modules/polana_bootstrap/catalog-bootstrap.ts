import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CatalogPriceKind,
  CatalogProduct,
  CatalogProductCategory,
  CatalogProductPrice,
  CatalogProductVariant,
} from '@open-mercato/core/modules/catalog/data/entities'
import {
  CustomFieldDef,
  CustomFieldEntityConfig,
  CustomFieldValue,
} from '@open-mercato/core/modules/entities/data/entities'
import { ensureCustomFieldDefinitions } from '@open-mercato/core/modules/entities/lib/field-definitions'
import { CommandBus, type CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'
import { E } from '#generated/entities.ids.generated'
import type { BootstrapScope } from './customer-bootstrap'
import { POLANA_CATALOG_FIXTURES } from './catalog-fixtures'

const PRODUCT_FIELDSET = 'polana_service_details'
const PRODUCT_FIELDS: CustomFieldDefinition[] = [
  { key: 'session_details', kind: 'multiline', label: 'Szczegóły spotkań', formEditable: true, fieldset: PRODUCT_FIELDSET },
  { key: 'price_max_pln', kind: 'float', label: 'Cena maksymalna (PLN)', formEditable: true, fieldset: PRODUCT_FIELDSET },
  { key: 'surcharge_amount_pln', kind: 'float', label: 'Dopłata (PLN)', formEditable: true, fieldset: PRODUCT_FIELDSET },
  { key: 'pricing_note', kind: 'multiline', label: 'Informacja o cenie', formEditable: true, fieldset: PRODUCT_FIELDSET },
]

type CategoryRecord = { id: string; name: string; slug?: string | null; deleted?: boolean }
type ProductRecord = { id: string; sku?: string | null }
type VariantRecord = { id: string; sku?: string | null; productId: string }
type PriceRecord = { id: string; variantId: string; priceKindId: string; currencyCode: string }

export function isPolanaProductFieldKey(key: string): boolean {
  return PRODUCT_FIELDS.some((field) => field.key === key)
}

async function removeNonPolanaProductFields(em: EntityManager, scope: BootstrapScope): Promise<void> {
  const scopedDefinitions = await em.find(CustomFieldDef, {
    entityId: E.catalog.catalog_product,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  const unrelatedDefinitions = scopedDefinitions.filter((definition) => !isPolanaProductFieldKey(definition.key))
  const unrelatedKeys = [...new Set(unrelatedDefinitions.map((definition) => definition.key))]
  if (unrelatedKeys.length === 0) return
  await em.nativeDelete(CustomFieldValue, {
    entityId: E.catalog.catalog_product,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fieldKey: { $in: unrelatedKeys },
  })
  await em.nativeDelete(CustomFieldDef, { id: { $in: unrelatedDefinitions.map((definition) => definition.id) } })
}

export type CatalogBootstrapDependencies = {
  ensureFields(scope: BootstrapScope): Promise<void>
  listCategories(scope: BootstrapScope): Promise<CategoryRecord[]>
  listProducts(scope: BootstrapScope): Promise<ProductRecord[]>
  listVariants(scope: BootstrapScope): Promise<VariantRecord[]>
  listPrices(scope: BootstrapScope): Promise<PriceRecord[]>
  regularPriceKindId(scope: BootstrapScope): Promise<string>
  restoreCategory(categoryId: string, scope: BootstrapScope): Promise<void>
  execute(commandId: string, input: Record<string, unknown>, scope: BootstrapScope): Promise<unknown>
  setProductFields(recordId: string, values: Record<string, string | number | null>, scope: BootstrapScope): Promise<void>
}

export type CatalogBootstrapSummary = {
  createdCategories: number
  createdProducts: number
  updatedProducts: number
  createdVariants: number
  updatedVariants: number
  createdPrices: number
  updatedPrices: number
}

export type CatalogBootstrapPlan = {
  categoriesToCreate: number
  productsToCreate: number
  productsToUpdate: number
  variantsToCreate: number
  variantsToUpdate: number
  pricesToCreate: number
  pricesToUpdate: number
}

function slug(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export async function planPolanaCatalog(
  dependencies: CatalogBootstrapDependencies,
  scope: BootstrapScope,
): Promise<CatalogBootstrapPlan> {
  if (!scope.tenantId || !scope.organizationId) throw new Error('Polana catalog bootstrap requires tenant and organization scope')
  const [categories, products, variants, prices, regularPriceKindId] = await Promise.all([
    dependencies.listCategories(scope),
    dependencies.listProducts(scope),
    dependencies.listVariants(scope),
    dependencies.listPrices(scope),
    dependencies.regularPriceKindId(scope),
  ])
  const categoryKeys = new Set(categories.flatMap((item) => [item.name, item.slug].filter((value): value is string => Boolean(value))))
  const productSkus = new Set(products.flatMap((item) => item.sku ? [item.sku] : []))
  const variantBySku = new Map(variants.flatMap((item) => item.sku ? [[item.sku, item]] : []))
  const pricedVariantIds = new Set(prices.filter((item) => item.priceKindId === regularPriceKindId && item.currencyCode === 'PLN').map((item) => item.variantId))
  const uniqueCategories = new Set(POLANA_CATALOG_FIXTURES.map((fixture) => fixture.category))
  return {
    categoriesToCreate: [...uniqueCategories].filter((name) => !categoryKeys.has(name) && !categoryKeys.has(slug(name))).length,
    productsToCreate: POLANA_CATALOG_FIXTURES.filter((fixture) => !productSkus.has(fixture.sku)).length,
    productsToUpdate: POLANA_CATALOG_FIXTURES.filter((fixture) => productSkus.has(fixture.sku)).length,
    variantsToCreate: POLANA_CATALOG_FIXTURES.filter((fixture) => !variantBySku.has(fixture.sku)).length,
    variantsToUpdate: POLANA_CATALOG_FIXTURES.filter((fixture) => variantBySku.has(fixture.sku)).length,
    pricesToCreate: POLANA_CATALOG_FIXTURES.filter((fixture) => {
      const variant = variantBySku.get(fixture.sku)
      return !variant || !pricedVariantIds.has(variant.id)
    }).length,
    pricesToUpdate: POLANA_CATALOG_FIXTURES.filter((fixture) => {
      const variant = variantBySku.get(fixture.sku)
      return variant ? pricedVariantIds.has(variant.id) : false
    }).length,
  }
}

export async function seedPolanaCatalog(
  dependencies: CatalogBootstrapDependencies,
  scope: BootstrapScope,
): Promise<CatalogBootstrapSummary> {
  if (!scope.tenantId || !scope.organizationId) throw new Error('Polana catalog bootstrap requires tenant and organization scope')
  await dependencies.ensureFields(scope)

  const [categories, products, variants, prices, regularPriceKindId] = await Promise.all([
    dependencies.listCategories(scope),
    dependencies.listProducts(scope),
    dependencies.listVariants(scope),
    dependencies.listPrices(scope),
    dependencies.regularPriceKindId(scope),
  ])
  const categoryByName = new Map(categories.flatMap((item) => [
    [item.name, item.id] as const,
    ...(item.slug ? [[item.slug, item.id] as const] : []),
  ]))
  const productBySku = new Map(products.flatMap((item) => item.sku ? [[item.sku, item]] : []))
  const variantBySku = new Map(variants.flatMap((item) => item.sku ? [[item.sku, item]] : []))
  const priceByVariant = new Map(prices.filter((item) => item.priceKindId === regularPriceKindId && item.currencyCode === 'PLN').map((item) => [item.variantId, item]))
  const summary: CatalogBootstrapSummary = { createdCategories: 0, createdProducts: 0, updatedProducts: 0, createdVariants: 0, updatedVariants: 0, createdPrices: 0, updatedPrices: 0 }

  for (const name of new Set(POLANA_CATALOG_FIXTURES.map((fixture) => fixture.category))) {
    const categorySlug = slug(name)
    if (categoryByName.has(name) || categoryByName.has(categorySlug)) {
      const categoryId = categoryByName.get(name) ?? categoryByName.get(categorySlug)!
      const existing = categories.find((item) => item.id === categoryId)
      if (existing?.deleted) await dependencies.restoreCategory(categoryId, scope)
      categoryByName.set(name, categoryId)
      continue
    }
    const created = await dependencies.execute('catalog.categories.create', { ...scope, name, slug: categorySlug, isActive: true }, scope) as { categoryId: string }
    categoryByName.set(name, created.categoryId)
    summary.createdCategories += 1
  }

  for (const fixture of POLANA_CATALOG_FIXTURES) {
    const categoryId = categoryByName.get(fixture.category)
    if (!categoryId) throw new Error(`Missing category ${fixture.category}`)
    const productInput = {
      ...scope,
      title: fixture.title,
      description: fixture.description ?? '',
      sku: fixture.sku,
      handle: fixture.sku.toLowerCase(),
      productType: 'simple',
      primaryCurrencyCode: 'PLN',
      defaultUnit: 'pc',
      defaultSalesUnit: 'pc',
      categoryIds: [categoryId],
      isActive: true,
    }
    const existingProduct = productBySku.get(fixture.sku)
    let productId: string
    if (existingProduct) {
      await dependencies.execute('catalog.products.update', { id: existingProduct.id, ...productInput }, scope)
      productId = existingProduct.id
      summary.updatedProducts += 1
    } else {
      const created = await dependencies.execute('catalog.products.create', productInput, scope) as { productId: string }
      productId = created.productId
      summary.createdProducts += 1
    }
    await dependencies.setProductFields(productId, {
      session_details: null,
      price_max_pln: null,
      surcharge_amount_pln: null,
      pricing_note: null,
      ...fixture.customFields,
    }, scope)

    const existingVariant = variantBySku.get(fixture.sku)
    let variantId: string
    const variantInput = { ...scope, productId, name: 'Standard', sku: fixture.sku, isDefault: true, isActive: true }
    if (existingVariant) {
      await dependencies.execute('catalog.variants.update', { id: existingVariant.id, ...variantInput }, scope)
      variantId = existingVariant.id
      summary.updatedVariants += 1
    } else {
      const created = await dependencies.execute('catalog.variants.create', variantInput, scope) as { variantId: string }
      variantId = created.variantId
      summary.createdVariants += 1
    }

    const priceInput = {
      ...scope,
      productId,
      variantId,
      currencyCode: 'PLN',
      priceKindId: regularPriceKindId,
      minQuantity: 1,
      unitPriceNet: fixture.pricePln,
      unitPriceGross: fixture.pricePln,
      taxRate: 0,
    }
    const existingPrice = priceByVariant.get(variantId)
    if (existingPrice) {
      await dependencies.execute('catalog.prices.update', { id: existingPrice.id, ...priceInput }, scope)
      summary.updatedPrices += 1
    } else {
      await dependencies.execute('catalog.prices.create', priceInput, scope)
      summary.createdPrices += 1
    }
  }
  return summary
}

function commandContext(container: AwilixContainer, scope: BootstrapScope): CommandRuntimeContext {
  return {
    container,
    auth: { sub: 'system:polana_bootstrap', userId: 'system:polana_bootstrap', tenantId: scope.tenantId, orgId: scope.organizationId },
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    syncOrigin: 'polana_bootstrap:setup',
    systemActor: true,
  }
}

export function createCatalogBootstrapDependencies(em: EntityManager, container: AwilixContainer): CatalogBootstrapDependencies {
  const commandBus = container.resolve<CommandBus>('commandBus')
  const dataEngine = container.resolve<DataEngine>('dataEngine')
  return {
    ensureFields: async (scope) => {
      const now = new Date()
      await removeNonPolanaProductFields(em, scope)
      let config = await em.findOne(CustomFieldEntityConfig, { entityId: E.catalog.catalog_product, ...scope })
      if (!config) config = em.create(CustomFieldEntityConfig, { entityId: E.catalog.catalog_product, ...scope, isActive: true, createdAt: now, updatedAt: now })
      const current = config.configJson && typeof config.configJson === 'object' ? config.configJson as Record<string, unknown> : {}
      config.configJson = {
        ...current,
        fieldsets: [{ code: PRODUCT_FIELDSET, label: 'Szczegóły usług Polany Przygody' }],
        singleFieldsetPerRecord: false,
      }
      config.isActive = true
      config.updatedAt = now
      em.persist(config)
      await ensureCustomFieldDefinitions(em, [{ entity: E.catalog.catalog_product, fields: PRODUCT_FIELDS, source: 'polana_bootstrap' }], scope)
      await em.flush()
    },
    listCategories: async (scope) => (await em.find(CatalogProductCategory, scope)).map((item) => ({ id: item.id, name: item.name, slug: item.slug, deleted: Boolean(item.deletedAt) })),
    listProducts: async (scope) => (await em.find(CatalogProduct, { ...scope, deletedAt: null })).map((item) => ({ id: item.id, sku: item.sku })),
    listVariants: async (scope) => (await em.find(CatalogProductVariant, { ...scope }, { populate: ['product'] })).map((item) => ({ id: item.id, sku: item.sku, productId: typeof item.product === 'string' ? item.product : item.product.id })),
    listPrices: async (scope) => (await em.find(CatalogProductPrice, { ...scope }, { populate: ['variant', 'priceKind'] })).flatMap((item) => {
      if (!item.variant) return []
      return [{ id: item.id, variantId: typeof item.variant === 'string' ? item.variant : item.variant.id, priceKindId: typeof item.priceKind === 'string' ? item.priceKind : item.priceKind.id, currencyCode: item.currencyCode }]
    }),
    regularPriceKindId: async (scope) => {
      const kind = await em.findOne(CatalogPriceKind, { tenantId: scope.tenantId, code: 'regular', $or: [{ organizationId: scope.organizationId }, { organizationId: null }] })
      if (!kind) throw new Error('Missing regular catalog price kind; run catalog seed defaults first')
      return kind.id
    },
    restoreCategory: async (categoryId, scope) => {
      const category = await em.findOneOrFail(CatalogProductCategory, { id: categoryId, ...scope })
      category.deletedAt = null
      category.isActive = true
      category.updatedAt = new Date()
      await em.flush()
    },
    execute: async (commandId, input, scope) => (await commandBus.execute(commandId, { input, ctx: commandContext(container, scope) })).result,
    setProductFields: async (recordId, values, scope) => dataEngine.setCustomFields({ entityId: E.catalog.catalog_product, recordId, ...scope, values, notify: true }),
  }
}
