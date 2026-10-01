import { createModuleQueue, type Queue } from '@open-mercato/queue'

export const VISIT_PAYMENT_EMAIL_QUEUE = 'patient-visit-payment-email'

const VISIT_PAYMENT_EMAIL_QUEUE_KEY = '__patientVisitPaymentEmailQueue__' as const

/** Deliberately scalar-only: the worker authoritatively re-reads every mutable value. */
export type VisitPaymentEmailJob = {
  deliveryId: string
  tenantId: string
  organizationId: string
}

/** Process-memoized so every dispatch in this runtime shares one queue client. */
export function getVisitPaymentEmailQueue(): Queue<VisitPaymentEmailJob> {
  const globalStore = globalThis as typeof globalThis & {
    [VISIT_PAYMENT_EMAIL_QUEUE_KEY]?: Queue<VisitPaymentEmailJob>
  }
  if (!globalStore[VISIT_PAYMENT_EMAIL_QUEUE_KEY]) {
    globalStore[VISIT_PAYMENT_EMAIL_QUEUE_KEY] = createModuleQueue<VisitPaymentEmailJob>(
      VISIT_PAYMENT_EMAIL_QUEUE,
      { concurrency: 5 },
    )
  }
  return globalStore[VISIT_PAYMENT_EMAIL_QUEUE_KEY]
}
