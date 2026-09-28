'use client'

import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import ProductFormSimplifierWidget, { installProductFormSimplifier } from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'polana_bootstrap.injection.product-form-simplifier',
    title: 'Polana product form simplifier',
    description: 'Hides catalog sections that do not apply to Polana services.',
    priority: -100,
    enabled: true,
  },
  Widget: ProductFormSimplifierWidget,
  eventHandlers: {
    onLoad: async () => installProductFormSimplifier(),
  },
}

export default widget
