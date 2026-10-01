import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { setRecordCustomFields } from '@open-mercato/core/modules/entities/lib/helpers'
import type { EventBus } from '@open-mercato/events/types'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { PatientVisit } from '../data/entities'
import { isLockWaitTimeout, resolvePatientLockWaitTimeoutMs } from '../lib/commandSupport'
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
  const rootEm = container.resolve<EntityManager>('em')
  const eventBus = container.resolve<EventBus>('eventBus')
  const outcome = await applyPaymentCompletion(payload, {
    async findVisitsByPaymentLink(linkId, scope) {
      const result = await queryEngine.query<Record<string, unknown>>(PATIENT_VISIT_ENTITY_ID, {
        fields: ['id'],
        filters: { 'cf:payment_link_id': { $eq: linkId } },
        page: { page: 1, pageSize: 2 },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
      return result.items
    },
    completeVisitForLink: async (visitId, linkId, receivedAt, scope) => {
      const result = await rootEm.fork().transactional(async (tx) => {
        const lockTimeoutMs = resolvePatientLockWaitTimeoutMs()
        if (lockTimeoutMs > 0) {
          await tx.execute('select set_config(?, ?, true)', ['lock_timeout', `${lockTimeoutMs}ms`])
        }
        let visit: PatientVisit | null
        try {
          visit = await tx.findOne(PatientVisit, {
            id: visitId,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            deletedAt: null,
          } as FilterQuery<PatientVisit>, { lockMode: LockMode.PESSIMISTIC_WRITE })
        } catch (error) {
          if (isLockWaitTimeout(error)) {
            throw new Error('Timed out while serializing checkout completion for a patient visit', { cause: error })
          }
          throw error
        }
        if (!visit) return 'ignored' as const

        const custom = await loadCustomFieldValues({
          em: tx,
          entityId: PATIENT_VISIT_ENTITY_ID,
          recordIds: [visitId],
          tenantIdByRecord: { [visitId]: scope.tenantId },
          organizationIdByRecord: { [visitId]: scope.organizationId },
        })
        const values = (custom[visitId] ?? {}) as Record<string, unknown>
        const storedLinkId = String(
          values.cf_payment_link_id ?? values['cf:payment_link_id'] ?? values.payment_link_id ?? '',
        ).trim()
        if (storedLinkId !== linkId) return 'ignored' as const
        const status = String(
          values.cf_payment_link_status ?? values['cf:payment_link_status'] ?? values.payment_link_status ?? '',
        ).trim()
        const storedReceivedAt = String(
          values.cf_payment_received_at ?? values['cf:payment_received_at'] ?? values.payment_received_at ?? '',
        ).trim()
        if (status === 'completed' && storedReceivedAt) return 'unchanged' as const

        await setRecordCustomFields(tx, {
          entityId: PATIENT_VISIT_ENTITY_ID,
          recordId: visitId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          values: {
            payment_link_status: 'completed',
            payment_received_at: storedReceivedAt || receivedAt,
          },
        })
        return 'updated' as const
      })
      if (result === 'updated') {
        await eventBus.emitEvent('patient.patient_visit.updated', {
          id: visitId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        }, {
          persistent: true,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          emitterModuleId: 'patient',
        })
      }
      return result
    },
  })
  if (outcome === 'ignored') {
    logger.debug('Completed checkout link is not attached to a patient visit', {
      transactionId: payload.transactionId,
    })
  }
}
