import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { reconcileCustomerIdentityProjection } from '../lib/customerIdentityProjection'

export const metadata = {
  event: 'customers.person.*',
  persistent: true,
  id: 'public_booking:customer-identity-projection',
}

export type CustomerPersonEventPayload = {
  entityId?: string | null
  tenantId?: string | null
  organizationId?: string | null
}

export default async function onCustomerPersonChanged(payload: CustomerPersonEventPayload): Promise<void> {
  if (!payload.entityId || !payload.tenantId || !payload.organizationId) return
  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  await reconcileCustomerIdentityProjection(em, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  }, payload.entityId)
}
