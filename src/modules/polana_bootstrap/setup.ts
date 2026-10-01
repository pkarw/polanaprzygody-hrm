import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { createCustomerBootstrapDependencies, seedPolanaCustomers } from './customer-bootstrap'
import { createCatalogBootstrapDependencies, seedPolanaCatalog } from './catalog-bootstrap'
import { createResourceBootstrapDependencies, seedPolanaResources } from './resource-bootstrap'
import { seedPolanaOrganization } from './organization-bootstrap'
import { seedPolanaTherapists } from './lib/staffBootstrap'
import {
  createPaymentLinkBootstrapDependencies,
  seedPolanaPaymentLinkTemplates,
} from './payment-link-bootstrap'
import {
  createBookingBootstrapDependencies,
  seedPolanaBookingDefaults,
} from './booking-bootstrap'
import { backfillCustomerIdentityProjections } from '../public_booking/lib/customerIdentityProjection'

export const setup: ModuleSetupConfig = {
  // These records are the operational baseline for public booking and visit
  // payment, not demo data. Keep the dependency order identical on regular and
  // `--no-examples` installs.
  seedDefaults: async (ctx) => {
    const scope = {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    }
    await seedPolanaOrganization(ctx.em, ctx.container, scope)
    await seedPolanaCustomers(createCustomerBootstrapDependencies(ctx.em, ctx.container), scope)
    // public_booking defaults run before this app-owned bootstrap on a fresh install,
    // so reconcile the customer identities immediately after their operational
    // fixtures exist. The customer event subscriber remains the ongoing path.
    await backfillCustomerIdentityProjections(ctx.em, scope)
    await seedPolanaCatalog(createCatalogBootstrapDependencies(ctx.em, ctx.container), scope)
    await seedPolanaPaymentLinkTemplates(createPaymentLinkBootstrapDependencies(ctx.em, ctx.container), scope)
    const resources = await seedPolanaResources(createResourceBootstrapDependencies(ctx.em, ctx.container), scope)
    if (!resources.availabilityRuleSetId) {
      throw new Error('Polana operational bootstrap requires a resolved availability rule set.')
    }
    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    await seedPolanaTherapists(ctx.em, dataEngine, scope, resources.availabilityRuleSetId)
    // Booking relations are resolved only after every owning fixture exists.
    // Exact stable keys make a missing/ambiguous fixture fatal instead of silently
    // assigning every therapist or room in the organization.
    await seedPolanaBookingDefaults(createBookingBootstrapDependencies(ctx.container), scope)
  },
}

export default setup
