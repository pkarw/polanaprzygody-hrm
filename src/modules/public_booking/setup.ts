import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { CustomFieldEntityConfig } from '@open-mercato/core/modules/entities/data/entities'
import { ensureCustomFieldDefinitions } from '@open-mercato/core/modules/entities/lib/field-definitions'
import { E } from '@/.mercato/generated/entities.ids.generated'
import {
  PUBLIC_BOOKING_PRODUCT_FIELDS,
  PUBLIC_BOOKING_PRODUCT_FIELDSET,
} from './lib/catalogBookingFields'
import { backfillCustomerIdentityProjections } from './lib/customerIdentityProjection'
import { provisionPublicBookingServiceIdentity } from './lib/serviceCredential'

export const setup: ModuleSetupConfig = {
  async seedDefaults({ em, tenantId, organizationId, container }) {
    if (!tenantId || !organizationId) {
      throw new Error('Public booking field setup requires tenantId and organizationId')
    }
    const scope = { tenantId, organizationId }
    const now = new Date()
    let config = await em.findOne(CustomFieldEntityConfig, {
      entityId: E.catalog.catalog_product,
      ...scope,
    })
    if (!config) {
      config = em.create(CustomFieldEntityConfig, {
        entityId: E.catalog.catalog_product,
        ...scope,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
    }
    const current = config.configJson && typeof config.configJson === 'object'
      ? config.configJson as Record<string, unknown>
      : {}
    const fieldsets = Array.isArray(current.fieldsets) ? current.fieldsets : []
    config.configJson = {
      ...current,
      fieldsets: [
        ...fieldsets.filter((entry) => (
          !entry || typeof entry !== 'object'
          || (entry as { code?: unknown }).code !== PUBLIC_BOOKING_PRODUCT_FIELDSET
        )),
        { code: PUBLIC_BOOKING_PRODUCT_FIELDSET, label: 'Rezerwacja online' },
      ],
      singleFieldsetPerRecord: false,
    }
    config.isActive = true
    config.updatedAt = now
    em.persist(config)
    await ensureCustomFieldDefinitions(em, [{
      entity: E.catalog.catalog_product,
      fields: PUBLIC_BOOKING_PRODUCT_FIELDS,
      source: 'public_booking',
    }], scope)
    await em.flush()
    await backfillCustomerIdentityProjections(em, scope)
    await provisionPublicBookingServiceIdentity({ em, container, scope })
  },
}

export default setup
