import { describe, expect, it, jest } from '@jest/globals'
import { POLANA_CATALOG_FIXTURES } from '../catalog-fixtures'
import {
  seedPolanaPaymentLinkTemplates,
  type PaymentLinkBootstrapDependencies,
  type PaymentTemplateInput,
  type PaymentTemplateRecord,
} from '../payment-link-bootstrap'
import {
  GENERIC_CHECKOUT_TEMPLATE_NAMES,
  POLANA_MULTI_PAYMENT_FIXTURE_KEY,
  POLANA_MULTI_PAYMENT_TEMPLATE_NAME,
  POLANA_PAYMENT_TEMPLATE_FIXTURES,
} from '../payment-link-fixtures'

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
}

function createHarness(initialTemplates: PaymentTemplateRecord[] = []) {
  const templates = initialTemplates.map((template) => ({ ...template }))
  const inputs = new Map<string, PaymentTemplateInput>()
  let sequence = 0
  const ensureFields = jest.fn(async (_scope: typeof scope) => undefined)
  const createTemplate = jest.fn(async (input: PaymentTemplateInput) => {
    const id = `created-${++sequence}`
    templates.push({ id, name: input.name, status: input.status })
    inputs.set(id, input)
    return id
  })
  const updateTemplate = jest.fn(async (id: string, input: PaymentTemplateInput) => {
    const template = templates.find((item) => item.id === id)
    if (!template) throw new Error(`Missing template ${id}`)
    template.name = input.name
    template.status = input.status
    inputs.set(id, input)
  })
  const inactivateTemplate = jest.fn(async (id: string) => {
    const template = templates.find((item) => item.id === id)
    if (!template) throw new Error(`Missing template ${id}`)
    template.status = 'inactive'
  })
  const setTemplateFields = jest.fn(async (
    id: string,
    values: { polana_payment_fixture_key: string; catalog_product_id: string | null; catalog_product_sku: string | null },
  ) => {
    const template = templates.find((item) => item.id === id)
    if (!template) throw new Error(`Missing template ${id}`)
    template.fixtureKey = values.polana_payment_fixture_key
    template.catalogProductSku = values.catalog_product_sku
  })
  const dependencies = {
    ensureFields,
    listProducts: jest.fn(async () => POLANA_CATALOG_FIXTURES.map((fixture) => ({
      id: `product-${fixture.sku}`,
      sku: fixture.sku,
    }))),
    listTemplates: jest.fn(async () => templates.map((template) => ({ ...template }))),
    createTemplate,
    updateTemplate,
    inactivateTemplate,
    setTemplateFields,
  } satisfies PaymentLinkBootstrapDependencies
  return {
    dependencies,
    templates,
    inputs,
    ensureFields,
    createTemplate,
    updateTemplate,
    inactivateTemplate,
    setTemplateFields,
  }
}

describe('Polana payment-link template bootstrap', () => {
  it('creates eight branded fixed-price service templates and one valid shared draft', async () => {
    const harness = createHarness()

    await expect(seedPolanaPaymentLinkTemplates(harness.dependencies, scope)).resolves.toEqual({
      createdTemplates: 9,
      updatedTemplates: 0,
      inactivatedTemplates: 0,
    })

    expect(harness.ensureFields).toHaveBeenCalledWith(scope)
    expect(harness.createTemplate).toHaveBeenCalledTimes(9)
    const serviceInputs = [...harness.inputs.values()].filter((input) => input.name !== POLANA_MULTI_PAYMENT_TEMPLATE_NAME)
    expect(serviceInputs).toHaveLength(8)
    expect(serviceInputs.every((input) =>
      input.pricingMode === 'fixed'
      && input.fixedPriceCurrencyCode === 'PLN'
      && input.status === 'active'
      && input.gatewayProviderKey === 'stripe'
      && input.logoUrl === 'https://polanaprzygody.pl/logo-polana.svg'
      && input.primaryColor === '#2A5C47'
      && input.secondaryColor === '#1E4435'
      && input.backgroundColor === '#EFF1C5'
    )).toBe(true)
    const shared = [...harness.inputs.values()].find((input) => input.name === POLANA_MULTI_PAYMENT_TEMPLATE_NAME)
    expect(shared).toEqual(expect.objectContaining({
      pricingMode: 'fixed',
      fixedPriceAmount: 1,
      fixedPriceCurrencyCode: 'PLN',
      gatewayProviderKey: 'stripe',
      status: 'draft',
    }))
  })

  it('is idempotent on rerun and keeps one record per stable fixture key', async () => {
    const harness = createHarness()

    await seedPolanaPaymentLinkTemplates(harness.dependencies, scope)
    await expect(seedPolanaPaymentLinkTemplates(harness.dependencies, scope)).resolves.toEqual({
      createdTemplates: 0,
      updatedTemplates: 9,
      inactivatedTemplates: 0,
    })

    expect(harness.createTemplate).toHaveBeenCalledTimes(9)
    expect(harness.templates).toHaveLength(9)
    expect(new Set(harness.templates.map((template) => template.fixtureKey))).toEqual(
      new Set(POLANA_PAYMENT_TEMPLATE_FIXTURES.map((fixture) => fixture.fixtureKey)),
    )
  })

  it('inactivates exact generic examples, duplicates, and removed Polana fixtures without deleting records', async () => {
    const firstFixture = POLANA_PAYMENT_TEMPLATE_FIXTURES[0]!
    const initialTemplates: PaymentTemplateRecord[] = [
      ...GENERIC_CHECKOUT_TEMPLATE_NAMES.map((name, index) => ({ id: `generic-${index}`, name, status: 'draft' as const })),
      { id: 'a-kept-service', name: firstFixture.name, status: 'active', fixtureKey: firstFixture.fixtureKey, catalogProductSku: firstFixture.sku },
      { id: 'z-duplicate-service', name: firstFixture.name, status: 'active', fixtureKey: firstFixture.fixtureKey, catalogProductSku: firstFixture.sku },
      { id: 'removed-service', name: 'Polana — wycofana usługa', status: 'active', fixtureKey: 'service:PP-REMOVED', catalogProductSku: 'PP-REMOVED' },
      { id: 'unrelated', name: 'Customer-owned template', status: 'active' },
    ]
    const harness = createHarness(initialTemplates)

    const result = await seedPolanaPaymentLinkTemplates(harness.dependencies, scope)

    expect(result).toEqual({ createdTemplates: 8, updatedTemplates: 1, inactivatedTemplates: 5 })
    expect(harness.inactivateTemplate.mock.calls.map(([id]) => id).sort()).toEqual([
      'generic-0',
      'generic-1',
      'generic-2',
      'removed-service',
      'z-duplicate-service',
    ])
    expect(harness.templates.find((template) => template.id === 'unrelated')?.status).toBe('active')
    expect(harness.templates).toHaveLength(initialTemplates.length + 8)
  })

  it('writes indexed fixture, catalog id, and catalog SKU values for every template', async () => {
    const harness = createHarness()

    await seedPolanaPaymentLinkTemplates(harness.dependencies, scope)

    expect(harness.setTemplateFields).toHaveBeenCalledTimes(9)
    const assignments = harness.setTemplateFields.mock.calls.map(([, values]) => values)
    expect(assignments).toEqual(expect.arrayContaining(POLANA_CATALOG_FIXTURES.map((fixture) => ({
      polana_payment_fixture_key: `service:${fixture.sku}`,
      catalog_product_id: `product-${fixture.sku}`,
      catalog_product_sku: fixture.sku,
    }))))
    expect(assignments).toContainEqual({
      polana_payment_fixture_key: POLANA_MULTI_PAYMENT_FIXTURE_KEY,
      catalog_product_id: null,
      catalog_product_sku: null,
    })
  })

  it('fails closed before definitions, lookups, or mutations when scope is incomplete', async () => {
    const harness = createHarness()

    await expect(seedPolanaPaymentLinkTemplates(harness.dependencies, {
      tenantId: scope.tenantId,
      organizationId: '',
    })).rejects.toThrow('requires tenant and organization scope')

    expect(harness.ensureFields).not.toHaveBeenCalled()
    expect(harness.dependencies.listProducts).not.toHaveBeenCalled()
    expect(harness.createTemplate).not.toHaveBeenCalled()
  })

  it('fails before template mutation when a required scoped catalog product is absent', async () => {
    const harness = createHarness()
    harness.dependencies.listProducts.mockResolvedValue([])

    await expect(seedPolanaPaymentLinkTemplates(harness.dependencies, scope)).rejects.toThrow('requires catalog products')

    expect(harness.createTemplate).not.toHaveBeenCalled()
    expect(harness.updateTemplate).not.toHaveBeenCalled()
    expect(harness.setTemplateFields).not.toHaveBeenCalled()
  })
})
