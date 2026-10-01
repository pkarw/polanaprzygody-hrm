import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { seedPolanaOrganization } from '../organization-bootstrap'
import { createCustomerBootstrapDependencies, seedPolanaCustomers } from '../customer-bootstrap'
import { createCatalogBootstrapDependencies, seedPolanaCatalog } from '../catalog-bootstrap'
import {
  createPaymentLinkBootstrapDependencies,
  seedPolanaPaymentLinkTemplates,
} from '../payment-link-bootstrap'
import { createResourceBootstrapDependencies, seedPolanaResources } from '../resource-bootstrap'
import { seedPolanaTherapists } from '../lib/staffBootstrap'
import { createBookingBootstrapDependencies, seedPolanaBookingDefaults } from '../booking-bootstrap'
import { setup } from '../setup'
import { backfillCustomerIdentityProjections } from '../../public_booking/lib/customerIdentityProjection'

jest.mock('../organization-bootstrap', () => ({ seedPolanaOrganization: jest.fn() }))
jest.mock('../customer-bootstrap', () => ({
  createCustomerBootstrapDependencies: jest.fn(),
  seedPolanaCustomers: jest.fn(),
}))
jest.mock('../catalog-bootstrap', () => ({
  createCatalogBootstrapDependencies: jest.fn(),
  seedPolanaCatalog: jest.fn(),
}))
jest.mock('../payment-link-bootstrap', () => ({
  createPaymentLinkBootstrapDependencies: jest.fn(),
  seedPolanaPaymentLinkTemplates: jest.fn(),
}))
jest.mock('../resource-bootstrap', () => ({
  createResourceBootstrapDependencies: jest.fn(),
  seedPolanaResources: jest.fn(),
}))
jest.mock('../lib/staffBootstrap', () => ({ seedPolanaTherapists: jest.fn() }))
jest.mock('../booking-bootstrap', () => ({
  createBookingBootstrapDependencies: jest.fn(),
  seedPolanaBookingDefaults: jest.fn(),
}))
jest.mock('../../public_booking/lib/customerIdentityProjection', () => ({
  backfillCustomerIdentityProjections: jest.fn(),
}))

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
}

const mockOrganization = jest.mocked(seedPolanaOrganization)
const mockCustomers = jest.mocked(seedPolanaCustomers)
const mockCatalog = jest.mocked(seedPolanaCatalog)
const mockPaymentTemplates = jest.mocked(seedPolanaPaymentLinkTemplates)
const mockResources = jest.mocked(seedPolanaResources)
const mockTherapists = jest.mocked(seedPolanaTherapists)
const mockBooking = jest.mocked(seedPolanaBookingDefaults)
const mockCustomerIdentities = jest.mocked(backfillCustomerIdentityProjections)

function resourceSummary(availabilityRuleSetId: string | null) {
  return {
    removedResources: 0,
    removedResourceTypes: 0,
    removedResourceTags: 0,
    createdResourceTypes: 0,
    createdResourceTags: 0,
    createdResources: 4,
    updatedResources: 0,
    availabilityRuleSetId,
  }
}

function setupContext() {
  const dataEngine = { setCustomFields: jest.fn() } as unknown as DataEngine
  return {
    dataEngine,
    context: {
      em: {} as EntityManager,
      container: { resolve: jest.fn(() => dataEngine) },
      ...scope,
    },
  }
}

describe('Polana operational setup', () => {
  const order: string[] = []

  beforeEach(() => {
    jest.clearAllMocks()
    order.length = 0
    jest.mocked(createCustomerBootstrapDependencies).mockReturnValue({} as never)
    jest.mocked(createCatalogBootstrapDependencies).mockReturnValue({} as never)
    jest.mocked(createPaymentLinkBootstrapDependencies).mockReturnValue({} as never)
    jest.mocked(createResourceBootstrapDependencies).mockReturnValue({} as never)
    jest.mocked(createBookingBootstrapDependencies).mockReturnValue({} as never)
    mockOrganization.mockImplementation(async () => { order.push('organization'); return {} as never })
    mockCustomers.mockImplementation(async () => { order.push('customers'); return {} as never })
    mockCustomerIdentities.mockImplementation(async () => { order.push('customer-identities') })
    mockCatalog.mockImplementation(async () => { order.push('catalog'); return {} as never })
    mockPaymentTemplates.mockImplementation(async () => { order.push('payment-templates'); return {} as never })
    mockResources.mockImplementation(async () => {
      order.push('resources')
      return resourceSummary('availability-rule-set-1')
    })
    mockTherapists.mockImplementation(async () => { order.push('therapists') })
    mockBooking.mockImplementation(async () => { order.push('booking-fields'); return {} as never })
  })

  it('runs every operational fixture from seedDefaults in dependency order', async () => {
    const { context, dataEngine } = setupContext()

    await expect(setup.seedDefaults?.(context as never)).resolves.toBeUndefined()

    expect(order).toEqual([
      'organization',
      'customers',
      'customer-identities',
      'catalog',
      'payment-templates',
      'resources',
      'therapists',
      'booking-fields',
    ])
    expect(mockTherapists).toHaveBeenCalledWith(
      context.em,
      dataEngine,
      scope,
      'availability-rule-set-1',
    )
    expect(setup.seedExamples).toBeDefined()
  })

  it('reruns the same default hook without depending on example seeding', async () => {
    const { context } = setupContext()

    await setup.seedDefaults?.(context as never)
    await setup.seedDefaults?.(context as never)

    expect(mockOrganization).toHaveBeenCalledTimes(2)
    expect(mockCustomers).toHaveBeenCalledTimes(2)
    expect(mockCustomerIdentities).toHaveBeenCalledTimes(2)
    expect(mockCatalog).toHaveBeenCalledTimes(2)
    expect(mockPaymentTemplates).toHaveBeenCalledTimes(2)
    expect(mockResources).toHaveBeenCalledTimes(2)
    expect(mockTherapists).toHaveBeenCalledTimes(2)
    expect(mockBooking).toHaveBeenCalledTimes(2)
  })

  it('reconciles only payment templates after installed example seeding', async () => {
    const { context } = setupContext()

    await expect(setup.seedExamples?.(context as never)).resolves.toBeUndefined()

    expect(mockPaymentTemplates).toHaveBeenCalledTimes(1)
    expect(mockPaymentTemplates).toHaveBeenCalledWith(expect.anything(), scope)
    expect(mockOrganization).not.toHaveBeenCalled()
    expect(mockCustomers).not.toHaveBeenCalled()
    expect(mockCustomerIdentities).not.toHaveBeenCalled()
    expect(mockCatalog).not.toHaveBeenCalled()
    expect(mockResources).not.toHaveBeenCalled()
    expect(mockTherapists).not.toHaveBeenCalled()
    expect(mockBooking).not.toHaveBeenCalled()
  })

  it('fails closed before therapist or booking writes when schedule resolution is absent', async () => {
    const { context } = setupContext()
    mockResources.mockResolvedValueOnce(resourceSummary(null))

    await expect(setup.seedDefaults?.(context as never)).rejects.toThrow(
      'requires a resolved availability rule set',
    )
    expect(mockTherapists).not.toHaveBeenCalled()
    expect(mockBooking).not.toHaveBeenCalled()
  })
})
