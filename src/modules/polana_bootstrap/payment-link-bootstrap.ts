import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CatalogProduct } from '@open-mercato/core/modules/catalog/data/entities'
import {
  CustomFieldEntityConfig,
  CustomFieldValue,
} from '@open-mercato/core/modules/entities/data/entities'
import { ensureCustomFieldDefinitions } from '@open-mercato/core/modules/entities/lib/field-definitions'
import { CheckoutLinkTemplate } from '@open-mercato/checkout/modules/checkout/data/entities'
import { DEFAULT_CHECKOUT_CUSTOMER_FIELDS } from '@open-mercato/checkout/modules/checkout/setup'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'
import type { BootstrapScope } from './customer-bootstrap'
import {
  GENERIC_CHECKOUT_TEMPLATE_NAMES,
  POLANA_CHECKOUT_LOGO_URL,
  POLANA_PAYMENT_TEMPLATE_FIXTURES,
  POLANA_PAYMENT_TEMPLATE_PREFIX,
  type PolanaPaymentTemplateFixture,
} from './payment-link-fixtures'

const CHECKOUT_TEMPLATE_ENTITY_ID = 'checkout:checkout_link_template'
const PAYMENT_FIELDSET = 'polana_payment_service'

export const POLANA_PAYMENT_TEMPLATE_FIELDS = [
  {
    key: 'polana_payment_fixture_key',
    kind: 'text',
    label: 'Klucz szablonu Polany',
    fieldset: PAYMENT_FIELDSET,
    formEditable: false,
    indexed: true,
    filterable: true,
  },
  {
    key: 'catalog_product_id',
    kind: 'text',
    label: 'Identyfikator usługi katalogowej',
    fieldset: PAYMENT_FIELDSET,
    formEditable: false,
    indexed: true,
    filterable: true,
  },
  {
    key: 'catalog_product_sku',
    kind: 'text',
    label: 'SKU usługi katalogowej',
    fieldset: PAYMENT_FIELDSET,
    formEditable: false,
    indexed: true,
    filterable: true,
  },
] satisfies CustomFieldDefinition[]

export type PaymentTemplateRecord = {
  id: string
  name: string
  status: 'draft' | 'active' | 'inactive'
  fixtureKey?: string | null
  catalogProductSku?: string | null
}

export type CatalogProductRecord = { id: string; sku?: string | null }

export type PaymentTemplateInput = {
  name: string
  title: string
  subtitle: string
  description: string
  logoUrl: string
  primaryColor: string
  secondaryColor: string
  backgroundColor: string
  themeMode: 'light'
  pricingMode: 'fixed'
  fixedPriceAmount: number
  fixedPriceCurrencyCode: 'PLN'
  fixedPriceIncludesTax: true
  gatewayProviderKey: 'stripe'
  collectCustomerDetails: true
  customerFieldsSchema: Array<Record<string, unknown>>
  successTitle: string
  successMessage: string
  cancelTitle: string
  cancelMessage: string
  errorTitle: string
  errorMessage: string
  maxCompletions: 1
  status: 'active' | 'draft'
  checkoutType: 'pay_link'
}

export type PaymentLinkBootstrapDependencies = {
  ensureFields(scope: BootstrapScope): Promise<void>
  listProducts(scope: BootstrapScope): Promise<CatalogProductRecord[]>
  listTemplates(scope: BootstrapScope): Promise<PaymentTemplateRecord[]>
  createTemplate(input: PaymentTemplateInput, scope: BootstrapScope): Promise<string>
  updateTemplate(id: string, input: PaymentTemplateInput, scope: BootstrapScope): Promise<void>
  inactivateTemplate(id: string, scope: BootstrapScope): Promise<void>
  setTemplateFields(
    recordId: string,
    values: { polana_payment_fixture_key: string; catalog_product_id: string | null; catalog_product_sku: string | null },
    scope: BootstrapScope,
  ): Promise<void>
}

export type PaymentLinkBootstrapSummary = {
  createdTemplates: number
  updatedTemplates: number
  inactivatedTemplates: number
}

function assertScope(scope: BootstrapScope): void {
  if (!scope.tenantId || !scope.organizationId) {
    throw new Error('Polana payment-link bootstrap requires tenant and organization scope')
  }
}

function templateInput(fixture: PolanaPaymentTemplateFixture): PaymentTemplateInput {
  return {
    name: fixture.name,
    title: fixture.title,
    subtitle: 'Centrum Rozwoju Dziecka Polana Przygody',
    description: fixture.description,
    logoUrl: POLANA_CHECKOUT_LOGO_URL,
    primaryColor: '#2A5C47',
    secondaryColor: '#1E4435',
    backgroundColor: '#EFF1C5',
    themeMode: 'light',
    pricingMode: 'fixed',
    fixedPriceAmount: fixture.fixedPriceAmount,
    fixedPriceCurrencyCode: 'PLN',
    fixedPriceIncludesTax: true,
    gatewayProviderKey: 'stripe',
    collectCustomerDetails: true,
    customerFieldsSchema: DEFAULT_CHECKOUT_CUSTOMER_FIELDS.map((field) => ({ ...field })),
    successTitle: 'Płatność zakończona',
    successMessage: 'Dziękujemy. Płatność za wizytę została przyjęta.',
    cancelTitle: 'Płatność anulowana',
    cancelMessage: 'Płatność nie została pobrana. Możesz wrócić do linku i spróbować ponownie.',
    errorTitle: 'Nie udało się zrealizować płatności',
    errorMessage: 'Spróbuj ponownie lub skontaktuj się z recepcją Polany Przygody.',
    maxCompletions: 1,
    status: fixture.status,
    checkoutType: 'pay_link',
  }
}

function choosePrimary(candidates: PaymentTemplateRecord[]): PaymentTemplateRecord | undefined {
  return [...candidates].sort((left, right) => left.id.localeCompare(right.id))[0]
}

export async function seedPolanaPaymentLinkTemplates(
  dependencies: PaymentLinkBootstrapDependencies,
  scope: BootstrapScope,
): Promise<PaymentLinkBootstrapSummary> {
  assertScope(scope)
  await dependencies.ensureFields(scope)

  const [products, templates] = await Promise.all([
    dependencies.listProducts(scope),
    dependencies.listTemplates(scope),
  ])
  const productBySku = new Map(products.flatMap((product) => product.sku ? [[product.sku, product]] : []))
  const missingSkus = POLANA_PAYMENT_TEMPLATE_FIXTURES
    .flatMap((fixture) => fixture.sku ? [fixture.sku] : [])
    .filter((sku) => !productBySku.has(sku))
  if (missingSkus.length > 0) {
    throw new Error(`Polana payment-link bootstrap requires catalog products: ${missingSkus.join(', ')}`)
  }

  const summary: PaymentLinkBootstrapSummary = {
    createdTemplates: 0,
    updatedTemplates: 0,
    inactivatedTemplates: 0,
  }
  const retainedIds = new Set<string>()
  const idsToInactivate = new Set<string>()

  for (const fixture of POLANA_PAYMENT_TEMPLATE_FIXTURES) {
    const candidates = templates.filter((template) =>
      template.fixtureKey === fixture.fixtureKey
      || (!template.fixtureKey && fixture.sku !== null && template.catalogProductSku === fixture.sku)
      || (!template.fixtureKey && template.name === fixture.name),
    )
    const existing = choosePrimary(candidates)
    const input = templateInput(fixture)
    let templateId: string

    if (existing) {
      templateId = existing.id
      await dependencies.updateTemplate(templateId, input, scope)
      summary.updatedTemplates += 1
    } else {
      templateId = await dependencies.createTemplate(input, scope)
      summary.createdTemplates += 1
    }

    retainedIds.add(templateId)
    for (const duplicate of candidates) {
      if (duplicate.id !== templateId) idsToInactivate.add(duplicate.id)
    }
    const product = fixture.sku ? productBySku.get(fixture.sku)! : null
    await dependencies.setTemplateFields(templateId, {
      polana_payment_fixture_key: fixture.fixtureKey,
      catalog_product_id: product?.id ?? null,
      catalog_product_sku: fixture.sku,
    }, scope)
  }

  const genericNames = new Set<string>(GENERIC_CHECKOUT_TEMPLATE_NAMES)
  const desiredFixtureKeys = new Set(POLANA_PAYMENT_TEMPLATE_FIXTURES.map((fixture) => fixture.fixtureKey))
  for (const template of templates) {
    const isKnownGeneric = genericNames.has(template.name)
    const isRemovedPolanaFixture = Boolean(
      template.fixtureKey?.startsWith('service:') && !desiredFixtureKeys.has(template.fixtureKey),
    )
    const isLegacyRemovedPolanaTemplate = template.name.startsWith(POLANA_PAYMENT_TEMPLATE_PREFIX)
      && !POLANA_PAYMENT_TEMPLATE_FIXTURES.some((fixture) => fixture.name === template.name)
    if (isKnownGeneric || isRemovedPolanaFixture || isLegacyRemovedPolanaTemplate) {
      idsToInactivate.add(template.id)
    }
  }

  for (const templateId of idsToInactivate) {
    if (retainedIds.has(templateId)) continue
    const current = templates.find((template) => template.id === templateId)
    if (current?.status === 'inactive') continue
    await dependencies.inactivateTemplate(templateId, scope)
    summary.inactivatedTemplates += 1
  }

  return summary
}

async function ensurePaymentTemplateFields(em: EntityManager, scope: BootstrapScope): Promise<void> {
  const now = new Date()
  let config = await em.findOne(CustomFieldEntityConfig, {
    entityId: CHECKOUT_TEMPLATE_ENTITY_ID,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  if (!config) {
    config = em.create(CustomFieldEntityConfig, {
      entityId: CHECKOUT_TEMPLATE_ENTITY_ID,
      ...scope,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
  }
  const current = config.configJson && typeof config.configJson === 'object' && !Array.isArray(config.configJson)
    ? { ...config.configJson }
    : {}
  const existingFieldsets = Array.isArray(current.fieldsets)
    ? current.fieldsets.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    : []
  const fieldsets = new Map(existingFieldsets.flatMap((fieldset) =>
    typeof fieldset.code === 'string' ? [[fieldset.code, fieldset] as const] : [],
  ))
  fieldsets.set(PAYMENT_FIELDSET, { code: PAYMENT_FIELDSET, label: 'Powiązanie z usługą Polany Przygody' })
  config.configJson = { ...current, fieldsets: [...fieldsets.values()] }
  config.isActive = true
  config.updatedAt = now
  em.persist(config)
  await ensureCustomFieldDefinitions(em, [{
    entity: CHECKOUT_TEMPLATE_ENTITY_ID,
    fields: POLANA_PAYMENT_TEMPLATE_FIELDS,
    source: 'polana_bootstrap',
  }], scope)
  await em.flush()
}

function assignTemplateValues(template: CheckoutLinkTemplate, input: PaymentTemplateInput): void {
  Object.assign(template, {
    ...input,
    fixedPriceAmount: input.fixedPriceAmount.toFixed(2),
    fixedPriceOriginalAmount: null,
    customAmountMin: null,
    customAmountMax: null,
    customAmountCurrencyCode: null,
    priceListItems: null,
    gatewaySettings: {},
    customFieldsetCode: null,
    legalDocuments: {},
    displayCustomFieldsOnPage: false,
    sendStartEmail: false,
    sendSuccessEmail: false,
    sendErrorEmail: false,
    passwordHash: null,
    deletedAt: null,
  })
}

export function createPaymentLinkBootstrapDependencies(
  em: EntityManager,
  container: AwilixContainer,
): PaymentLinkBootstrapDependencies {
  const dataEngine = container.resolve<DataEngine>('dataEngine')
  return {
    ensureFields: (scope) => ensurePaymentTemplateFields(em, scope),
    listProducts: async (scope) => (await em.find(CatalogProduct, { ...scope, deletedAt: null }))
      .map((product) => ({ id: product.id, sku: product.sku })),
    listTemplates: async (scope) => {
      const templates = await em.find(CheckoutLinkTemplate, { ...scope, deletedAt: null })
      if (templates.length === 0) return []
      const values = await em.find(CustomFieldValue, {
        entityId: CHECKOUT_TEMPLATE_ENTITY_ID,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        recordId: { $in: templates.map((template) => template.id) },
        fieldKey: { $in: ['polana_payment_fixture_key', 'catalog_product_sku'] },
        deletedAt: null,
      })
      const valuesByRecord = new Map<string, Map<string, string | null>>()
      for (const value of values) {
        const record = valuesByRecord.get(value.recordId) ?? new Map<string, string | null>()
        record.set(value.fieldKey, value.valueText ?? null)
        valuesByRecord.set(value.recordId, record)
      }
      return templates.map((template) => ({
        id: template.id,
        name: template.name,
        status: template.status,
        fixtureKey: valuesByRecord.get(template.id)?.get('polana_payment_fixture_key') ?? null,
        catalogProductSku: valuesByRecord.get(template.id)?.get('catalog_product_sku') ?? null,
      }))
    },
    createTemplate: async (input, scope) => {
      const template = em.create(CheckoutLinkTemplate, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        name: input.name,
        pricingMode: input.pricingMode,
      })
      assignTemplateValues(template, input)
      em.persist(template)
      await em.flush()
      return template.id
    },
    updateTemplate: async (id, input, scope) => {
      const template = await em.findOneOrFail(CheckoutLinkTemplate, { id, ...scope, deletedAt: null })
      assignTemplateValues(template, input)
      await em.flush()
    },
    inactivateTemplate: async (id, scope) => {
      const template = await em.findOneOrFail(CheckoutLinkTemplate, { id, ...scope, deletedAt: null })
      template.status = 'inactive'
      template.updatedAt = new Date()
      await em.flush()
    },
    setTemplateFields: async (recordId, values, scope) => dataEngine.setCustomFields({
      entityId: CHECKOUT_TEMPLATE_ENTITY_ID,
      recordId,
      ...scope,
      values,
      notify: true,
    }),
  }
}
