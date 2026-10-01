import { describe, expect, it, jest } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createLinkSchema } from '@open-mercato/checkout/modules/checkout/data/validators'
import { parseCheckoutInput } from '@open-mercato/checkout/modules/checkout/lib/utils'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import {
  createProductionDependencies,
  createVisitPaymentLinkServiceCore,
  VisitPaymentLinkError,
  type VisitPaymentLinkDependencies,
} from '../lib/visitPaymentLinkService'

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
}
const ctx = {} as CommandRuntimeContext

type HarnessOptions = {
  services?: Array<{ productId: string; title: string }>
  prices?: Array<{ productId: string; title: string; amount: string | number; currencyCode: string }>
  paymentLinkId?: string | null
  paymentLinkSlug?: string | null
  paymentLinkStatus?: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'inactive' | null
  paymentReceivedAt?: string | null
  checkoutCompleted?: boolean
}

function createHarness(options: HarnessOptions = {}) {
  const visit = {
    id: 'visit-1',
    updatedAt: '2026-10-01T09:00:00.000Z',
    services: options.services ?? [{ productId: 'product-1', title: 'Terapia' }],
    paymentLinkId: options.paymentLinkId ?? null,
    paymentLinkSlug: options.paymentLinkSlug ?? null,
    paymentLinkStatus: options.paymentLinkStatus ?? null,
    paymentReceivedAt: options.paymentReceivedAt ?? null,
  }
  const links: Array<{ id: string; slug: string; status: string; visitId: string; scope: typeof scope }> = []
  const createInputs: Array<Record<string, unknown>> = []
  const writeScopes: Array<typeof scope> = []
  let sequence = 0
  let lockTail = Promise.resolve()

  const dependencies: VisitPaymentLinkDependencies = {
    withLockedVisit: async (_visitId, targetScope, work) => {
      const previous = lockTail
      let release: () => void = () => {}
      lockTail = new Promise<void>((resolve) => { release = resolve })
      await previous
      try {
        if (targetScope.tenantId !== scope.tenantId || targetScope.organizationId !== scope.organizationId) {
          throw new VisitPaymentLinkError('payment_scope_required', 'scope mismatch')
        }
        return await work({ ...visit, services: visit.services.map((service) => ({ ...service })) })
      } finally {
        release()
      }
    },
    findLinkById: async (id, targetScope) => links.find((link) =>
      link.id === id
      && link.scope.tenantId === targetScope.tenantId
      && link.scope.organizationId === targetScope.organizationId
    ) ?? null,
    findActiveLinksForVisit: async (visitId, targetScope) => links.filter((link) =>
      link.visitId === visitId
      && ['active', 'draft'].includes(link.status)
      && link.scope.tenantId === targetScope.tenantId
      && link.scope.organizationId === targetScope.organizationId
    ),
    hasCompletedPayment: async () => options.checkoutCompleted === true,
    findTemplateForProduct: async () => [{
      id: '00000000-0000-4000-8000-000000000011',
      name: 'Service template',
    }],
    findMultiServiceTemplate: async () => [{
      id: '00000000-0000-4000-8000-000000000012',
      name: 'Multi template',
    }],
    resolveServicePrices: async () => options.prices ?? visit.services.map((service) => ({
      ...service,
      amount: '100.00',
      currencyCode: 'PLN',
    })),
    createLink: async (input) => {
      createInputs.push(input)
      const link = {
        id: `link-${++sequence}`,
        slug: `pay-${sequence}`,
        status: 'active',
        visitId: String(input.cf_patient_visit_id),
        scope,
      }
      links.push(link)
      return { id: link.id, slug: link.slug }
    },
    deactivateLink: async (id) => {
      const link = links.find((candidate) => candidate.id === id)
      if (link) link.status = 'inactive'
    },
    setVisitPaymentFields: async (_visitId, values, targetScope) => {
      writeScopes.push(targetScope)
      visit.paymentLinkId = values.payment_link_id ?? null
      visit.paymentLinkSlug = values.payment_link_slug ?? null
      visit.paymentLinkStatus = (values.payment_link_status as HarnessOptions['paymentLinkStatus']) ?? null
    },
    resolveTrustedOrigin: () => 'https://payments.example.test/app',
  }
  return {
    service: createVisitPaymentLinkServiceCore(dependencies),
    dependencies,
    visit,
    links,
    createInputs,
    writeScopes,
  }
}

describe('visit payment-link service', () => {
  it('uses only active multi-service templates and fails closed on a truncated scoped price set', async () => {
    const query = jest.fn(async (entityId: string, _options: unknown) => {
      if (entityId === 'checkout:checkout_link_template') {
        return {
          items: [{ id: 'template-active', name: 'Active template' }],
          page: 1,
          pageSize: 2,
          total: 1,
        }
      }
      return {
        items: [{ id: 'price-1', product_id: 'product-1', unit_price_gross: '100.00', currency_code: 'PLN' }],
        page: 1,
        pageSize: 100,
        total: 101,
      }
    })
    const production = createProductionDependencies(
      {} as EntityManager,
      { query } as unknown as QueryEngine,
      {} as CommandBus,
      {} as DataEngine,
      { resolvePrice: jest.fn(async () => null) },
    )

    await expect(production.findMultiServiceTemplate(scope)).resolves.toEqual([
      { id: 'template-active', name: 'Active template' },
    ])
    expect(query).toHaveBeenNthCalledWith(1, 'checkout:checkout_link_template', expect.objectContaining({
      filters: {
        'cf:polana_payment_fixture_key': { $eq: 'visit:multi' },
        status: { $eq: 'active' },
      },
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }))

    await expect(production.resolveServicePrices(
      [{ productId: 'product-1', title: 'Terapia' }],
      scope,
    )).rejects.toMatchObject({ code: 'payment_price_query_truncated' })
    expect(query).toHaveBeenNthCalledWith(2, 'catalog:catalog_product_price', expect.objectContaining({
      fields: expect.arrayContaining(['product_id', 'variant_id', 'price_kind_id']),
      filters: { product_id: { $eq: 'product-1' } },
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }))
  })

  it('creates a validator-complete fixed link for one service without price_list fields', async () => {
    const harness = createHarness({ prices: [
      { productId: 'product-1', title: 'Terapia', amount: '199.90', currencyCode: 'PLN' },
    ] })

    await expect(harness.service.ensureForVisit('visit-1', scope, ctx)).resolves.toEqual({
      id: 'link-1',
      slug: 'pay-1',
      url: 'https://payments.example.test/app/pay/pay-1',
      status: 'pending',
    })
    expect(harness.createInputs).toEqual([expect.objectContaining({
      templateId: '00000000-0000-4000-8000-000000000011',
      name: 'Płatność za wizytę visit-1',
      pricingMode: 'fixed',
      fixedPriceAmount: '199.90',
      fixedPriceCurrencyCode: 'PLN',
      fixedPriceIncludesTax: true,
      gatewayProviderKey: 'stripe',
      maxCompletions: 1,
      status: 'active',
      checkoutType: 'pay_link',
      customFields: { patient_visit_id: 'visit-1' },
      cf_patient_visit_id: 'visit-1',
    })])
    expect(harness.createInputs[0]).not.toHaveProperty('priceListItems')
    const parsed = parseCheckoutInput(harness.createInputs[0], createLinkSchema.parse)
    expect(parsed.parsed).toEqual(expect.objectContaining({
      pricingMode: 'fixed',
      fixedPriceAmount: 199.9,
      gatewayProviderKey: 'stripe',
    }))
    expect(parsed.customFields).toEqual({ patient_visit_id: 'visit-1' })
  })

  it('sums multiple current PLN prices in minor units and still creates one fixed link', async () => {
    const services = [
      { productId: 'product-1', title: 'Diagnoza' },
      { productId: 'product-2', title: 'Konsultacja' },
      { productId: 'product-3', title: 'Terapia' },
    ]
    const harness = createHarness({
      services,
      prices: [
        { ...services[0]!, amount: '0.10', currencyCode: 'PLN' },
        { ...services[1]!, amount: '0.20', currencyCode: 'PLN' },
        { ...services[2]!, amount: '199.7000', currencyCode: 'PLN' },
      ],
    })

    await harness.service.ensureForVisit('visit-1', scope, ctx)

    expect(harness.createInputs[0]).toEqual(expect.objectContaining({
      templateId: '00000000-0000-4000-8000-000000000012',
      pricingMode: 'fixed',
      fixedPriceAmount: '200.00',
    }))
    expect(harness.createInputs[0]).not.toHaveProperty('priceListItems')
  })

  it.each([
    { name: 'no services', options: { services: [] }, code: 'no_services_on_visit' },
    {
      name: 'missing price',
      options: {
        services: [{ productId: 'product-1', title: 'A' }, { productId: 'product-2', title: 'B' }],
        prices: [{ productId: 'product-1', title: 'A', amount: '10.00', currencyCode: 'PLN' }],
      },
      code: 'payment_price_missing',
    },
    {
      name: 'mixed currency',
      options: {
        services: [{ productId: 'product-1', title: 'A' }, { productId: 'product-2', title: 'B' }],
        prices: [
          { productId: 'product-1', title: 'A', amount: '10.00', currencyCode: 'PLN' },
          { productId: 'product-2', title: 'B', amount: '10.00', currencyCode: 'EUR' },
        ],
      },
      code: 'payment_currency_mismatch',
    },
  ])('fails before checkout for $name', async ({ options, code }) => {
    const harness = createHarness(options as HarnessOptions)
    await expect(harness.service.ensureForVisit('visit-1', scope, ctx)).rejects.toMatchObject({ code })
    expect(harness.createInputs).toHaveLength(0)
  })

  it('reuses an active scoped pointer without creating a second link', async () => {
    const harness = createHarness({
      paymentLinkId: 'link-existing',
      paymentLinkSlug: 'existing',
      paymentLinkStatus: 'processing',
    })
    harness.links.push({ id: 'link-existing', slug: 'existing', status: 'active', visitId: 'visit-1', scope })

    await expect(harness.service.ensureForVisit('visit-1', scope, ctx)).resolves.toMatchObject({
      id: 'link-existing',
      status: 'processing',
    })
    expect(harness.createInputs).toHaveLength(0)
  })

  it('adopts one indexed orphan and rejects ambiguous orphan matches', async () => {
    const adopted = createHarness()
    adopted.links.push({ id: 'orphan-1', slug: 'orphan', status: 'active', visitId: 'visit-1', scope })
    await expect(adopted.service.ensureForVisit('visit-1', scope, ctx)).resolves.toMatchObject({ id: 'orphan-1' })
    expect(adopted.visit.paymentLinkId).toBe('orphan-1')
    expect(adopted.createInputs).toHaveLength(0)

    const ambiguous = createHarness()
    ambiguous.links.push(
      { id: 'orphan-1', slug: 'one', status: 'active', visitId: 'visit-1', scope },
      { id: 'orphan-2', slug: 'two', status: 'active', visitId: 'visit-1', scope },
    )
    await expect(ambiguous.service.ensureForVisit('visit-1', scope, ctx)).rejects.toMatchObject({
      code: 'payment_link_orphan_ambiguous',
    })
    expect(ambiguous.createInputs).toHaveLength(0)
  })

  it('serializes concurrent retries so both callers receive the same link', async () => {
    const harness = createHarness()
    const results = await Promise.all([
      harness.service.ensureForVisit('visit-1', scope, ctx),
      harness.service.ensureForVisit('visit-1', scope, ctx),
    ])

    expect(results[0]).toEqual(results[1])
    expect(harness.createInputs).toHaveLength(1)
    expect(harness.links).toHaveLength(1)
  })

  it('keeps completed as an absorbing terminal state and performs no mutation', async () => {
    const harness = createHarness({
      paymentLinkId: 'paid-link',
      paymentLinkSlug: 'paid',
      paymentLinkStatus: 'completed',
      paymentReceivedAt: '2026-10-01T12:00:00.000Z',
    })
    harness.links.push({ id: 'paid-link', slug: 'paid', status: 'active', visitId: 'visit-1', scope })

    await expect(harness.service.ensureForVisit('visit-1', scope, ctx)).resolves.toEqual({
      id: 'paid-link',
      slug: 'paid',
      url: 'https://payments.example.test/app/pay/paid',
      status: 'completed',
    })
    expect(harness.createInputs).toHaveLength(0)
    expect(harness.writeScopes).toHaveLength(0)
  })

  it('deactivates an unpaid link and refuses to deactivate a completed payment', async () => {
    const unpaid = createHarness({
      paymentLinkId: 'link-active',
      paymentLinkSlug: 'active',
      paymentLinkStatus: 'pending',
    })
    unpaid.links.push({ id: 'link-active', slug: 'active', status: 'active', visitId: 'visit-1', scope })

    await expect(unpaid.service.deactivateForVisit('visit-1', scope, ctx)).resolves.toMatchObject({
      id: 'link-active',
      status: 'inactive',
    })
    expect(unpaid.links[0]?.status).toBe('inactive')
    expect(unpaid.visit.paymentLinkStatus).toBe('inactive')

    const paid = createHarness({
      paymentLinkId: 'link-paid',
      paymentLinkSlug: 'paid',
      paymentLinkStatus: 'completed',
    })
    await expect(paid.service.deactivateForVisit('visit-1', scope, ctx)).rejects.toMatchObject({
      code: 'visit_already_paid',
    })

    const projectedLate = createHarness({
      paymentLinkId: 'link-paid-authoritative',
      paymentLinkSlug: 'paid-authoritative',
      paymentLinkStatus: 'pending',
      checkoutCompleted: true,
    })
    projectedLate.links.push({
      id: 'link-paid-authoritative',
      slug: 'paid-authoritative',
      status: 'active',
      visitId: 'visit-1',
      scope,
    })
    await expect(projectedLate.service.deactivateForVisit('visit-1', scope, ctx)).rejects.toMatchObject({
      code: 'visit_already_paid',
    })
    expect(projectedLate.links[0]?.status).toBe('active')
    expect(projectedLate.visit.paymentLinkStatus).toBe('pending')
  })

  it('checks the expected visit version while holding the visit lock', async () => {
    const harness = createHarness()
    await expect(harness.service.ensureForVisit(
      'visit-1',
      scope,
      ctx,
      '2026-09-30T09:00:00.000Z',
    )).rejects.toMatchObject({ status: 409 })
    expect(harness.createInputs).toHaveLength(0)
  })

  it('keeps link lookup and writes inside the exact trusted scope', async () => {
    const harness = createHarness()
    harness.links.push({
      id: 'foreign-link',
      slug: 'foreign',
      status: 'active',
      visitId: 'visit-1',
      scope: { ...scope, organizationId: '00000000-0000-4000-8000-000000000099' },
    })

    const result = await harness.service.ensureForVisit('visit-1', scope, ctx)

    expect(result.id).toBe('link-1')
    expect(harness.writeScopes).toEqual([scope])
  })

  it('rejects incomplete scope before taking a lock or creating a link', async () => {
    const harness = createHarness()
    await expect(harness.service.ensureForVisit('visit-1', {
      tenantId: scope.tenantId,
      organizationId: '',
    }, ctx)).rejects.toMatchObject({ code: 'payment_scope_required' })
    expect(harness.createInputs).toHaveLength(0)
  })
})
