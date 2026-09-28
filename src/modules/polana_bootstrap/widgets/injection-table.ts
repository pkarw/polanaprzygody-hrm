import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'crud-form:catalog.product': {
    widgetId: 'polana_bootstrap.injection.product-form-simplifier',
    kind: 'stack',
    priority: -100,
  },
  'crud-form:catalog.catalog_product': {
    widgetId: 'polana_bootstrap.injection.product-form-simplifier',
    kind: 'stack',
    priority: -100,
  },
}

export default injectionTable
