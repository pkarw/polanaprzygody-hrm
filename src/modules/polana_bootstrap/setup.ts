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

export const setup: ModuleSetupConfig = {
  // The workspace identity is structural, not demo data: it must land even on a
  // `--no-examples` install.
  seedDefaults: async (ctx) => {
    await seedPolanaOrganization(ctx.em, ctx.container, {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
  },

  seedExamples: async (ctx) => {
    const scope = {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    }
    await seedPolanaCustomers(createCustomerBootstrapDependencies(ctx.em, ctx.container), scope)
    await seedPolanaCatalog(createCatalogBootstrapDependencies(ctx.em, ctx.container), scope)
    await seedPolanaPaymentLinkTemplates(createPaymentLinkBootstrapDependencies(ctx.em, ctx.container), scope)
    // Runs after the core `resources` seed, so its example set is already in the
    // database and can be replaced with the real gabinets in one pass.
    await seedPolanaResources(createResourceBootstrapDependencies(ctx.em, ctx.container), scope)
    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    await seedPolanaTherapists(ctx.em, dataEngine, scope)
  },
}

export default setup
