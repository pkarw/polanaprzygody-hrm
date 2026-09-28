import { describe, expect, it } from '@jest/globals'
import { enabledModules } from '../../../modules'

describe('polana_bootstrap module overrides', () => {
  it('replaces customer examples while retaining People and disabling Companies/Deals UI', () => {
    const customers = enabledModules.find((entry) => entry.id === 'customers')
    const staff = enabledModules.find((entry) => entry.id === 'staff')
    const polana = enabledModules.find((entry) => entry.id === 'polana_bootstrap')

    expect(customers?.overrides?.setup?.seedExamples).toBe(false)
    expect(staff?.overrides?.setup?.seedExamples).toBe(false)
    expect(polana).toBeDefined()
    expect(polana?.overrides?.routes?.pages).toEqual(expect.objectContaining({
      'backend:/backend/customers/companies': null,
      'backend:/backend/customers/companies/create': null,
      'backend:/backend/customers/companies/[id]': null,
      'backend:/backend/customers/companies-v2/[id]': null,
      'backend:/backend/customers/deals': null,
      'backend:/backend/customers/deals/create': null,
      'backend:/backend/customers/deals/[id]': null,
      'backend:/backend/customers/deals/map': null,
      'backend:/backend/customers/deals/pipeline': null,
      'backend:/backend/config/customers/deals': null,
      'backend:/backend/config/customers/pipeline-stages': null,
    }))
    expect(polana?.overrides?.routes?.pages).not.toHaveProperty('backend:/backend/customers/people')
    expect(polana?.overrides?.routes?.pages).toEqual(expect.objectContaining({
      'backend:/backend/sales/channels': null,
      'backend:/backend/sales/channels/offers': null,
      'backend:/backend/sales/orders': null,
      'backend:/backend/sales/quotes': null,
      'backend:/backend/config/sales': null,
    }))
    expect(polana?.overrides?.routes?.pages).not.toHaveProperty('backend:/backend/sales/orders/[id]')
    expect(polana?.overrides?.routes?.api).toBeUndefined()
    expect(polana?.overrides?.widgets?.dashboard).toEqual({ 'customers.dashboard.newDeals': null })
    expect(polana?.overrides?.widgets?.injection).toEqual({
      'customers.injection.ai-deal-analyzer-trigger': null,
      'customers.injection.ai-deal-detail-trigger': null,
    })
  })
})
