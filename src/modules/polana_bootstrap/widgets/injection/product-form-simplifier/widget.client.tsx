'use client'

import * as React from 'react'

export const POLANA_HIDDEN_PRODUCT_GROUP_IDS = ['dimensions', 'product-uom', 'compliance'] as const

let installedObserver: MutationObserver | null = null

export function installProductFormSimplifier(): void {
  if (typeof document === 'undefined' || installedObserver) return
  const hide = (element: HTMLElement | null | undefined) => {
    if (element) element.hidden = true
  }
  const cardFor = (selector: string) => document
    .querySelector<HTMLElement>(selector)
    ?.closest<HTMLElement>('.rounded-lg.border.bg-card')
  const apply = () => {
    for (const groupId of POLANA_HIDDEN_PRODUCT_GROUP_IDS) {
      hide(document.querySelector<HTMLElement>(`[data-collapsible-group-id="${groupId}"]`))
    }
    const uomCard = cardFor('#catalog-product-uom-base-unit')
    const complianceCard = cardFor('#catalog-product-compliance-country')
    hide(uomCard)
    hide(complianceCard)
    if (!uomCard && !complianceCard) return
    const detailsCard = cardFor('[data-crud-field-id="title"]')
    const dimensionsCard = detailsCard?.nextElementSibling
    if (dimensionsCard instanceof HTMLElement) hide(dimensionsCard)
  }
  apply()
  installedObserver = new MutationObserver(apply)
  installedObserver.observe(document.body, { childList: true, subtree: true })
}

/**
 * Presentation-only bridge for the installed catalog form. CrudForm exposes
 * stable group ids in the DOM, while the installed catalog page does not yet
 * forward its supported hiddenGroupIds prop.
 */
export default function ProductFormSimplifierWidget() {
  React.useEffect(() => {
    installProductFormSimplifier()
  }, [])

  return null
}
