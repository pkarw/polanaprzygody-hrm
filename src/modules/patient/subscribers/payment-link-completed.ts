import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { PATIENT_VISIT_ENTITY_ID } from '../lib/visitPaymentFields'
import {
  applyPaymentCompletion,
  type CheckoutTransactionCompletedPayload,
} from '../lib/visitPaymentCompletion'

const logger = createLogger('patient').child({ component: 'payment-link-completed' })

export const metadata = {
  event: 'checkout.transaction.completed',
  persistent: true,
  id: 'patient:payment-link-completed',
}

export default async function onPaymentLinkCompleted(
  payload: CheckoutTransactionCompletedPayload,
): Promise<void> {
  const container = await createRequestContainer()
  const queryEngine = container.resolve<QueryEngine>('queryEngine')
  const dataEngine = container.resolve<DataEngine>('dataEngine')
  const outcome = await applyPaymentCompletion(payload, {
    async findVisitsByPaymentLink(linkId, scope) {
      const result = await queryEngine.query<Record<string, unknown>>(PATIENT_VISIT_ENTITY_ID, {
        fields: ['id', 'cf:payment_link_status', 'cf:payment_received_at'],
        filters: { 'cf:payment_link_id': { $eq: linkId } },
        page: { page: 1, pageSize: 2 },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
      return result.items
    },
    setVisitPaymentCompleted: (visitId, receivedAt, scope) => dataEngine.setCustomFields({
      entityId: PATIENT_VISIT_ENTITY_ID,
      recordId: visitId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      values: {
        payment_link_status: 'completed',
        payment_received_at: receivedAt,
      },
      notify: true,
    }),
  })
  if (outcome === 'ignored') {
    logger.debug('Completed checkout link is not attached to a patient visit', {
      transactionId: payload.transactionId,
    })
  }
}
