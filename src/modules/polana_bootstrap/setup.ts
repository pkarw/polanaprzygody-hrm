import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { createCustomerBootstrapDependencies, seedPolanaCustomers } from './customer-bootstrap'
import { createCatalogBootstrapDependencies, seedPolanaCatalog } from './catalog-bootstrap'
import { seedPolanaTherapists } from './lib/staffBootstrap'

export const setup: ModuleSetupConfig = {
  seedExamples: async (ctx) => {
    const scope = {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    }
    await seedPolanaCustomers(createCustomerBootstrapDependencies(ctx.em, ctx.container), scope)
    await seedPolanaCatalog(createCatalogBootstrapDependencies(ctx.em, ctx.container), scope)
    const dataEngine = ctx.container.resolve<DataEngine>('dataEngine')
    await seedPolanaTherapists(ctx.em, dataEngine, scope)
  },
}

export default setup
