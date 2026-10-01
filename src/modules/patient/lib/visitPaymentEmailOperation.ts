import type { PatientVisitPaymentEmailDelivery } from '../data/entities'
import type { VisitPaymentEmailJob } from './visitPaymentEmailQueue'

type DurablePaymentEmailOperation = Pick<
  PatientVisitPaymentEmailDelivery,
  'id' | 'visitId' | 'paymentLinkId' | 'status'
>

export type DurablePaymentEmailDispatchDependencies = {
  findOrCreate(): Promise<DurablePaymentEmailOperation>
  enqueue(payload: VisitPaymentEmailJob): Promise<void>
  reject(code: 'payment_email_operation_mismatch' | 'payment_email_failed' | 'payment_email_ambiguous'): Promise<never>
}

export async function dispatchDurablePaymentEmailOperation(
  input: {
    visitId: string
    paymentLinkId: string
    tenantId: string
    organizationId: string
  },
  deps: DurablePaymentEmailDispatchDependencies,
): Promise<void> {
  const delivery = await deps.findOrCreate()
  if (delivery.visitId !== input.visitId || delivery.paymentLinkId !== input.paymentLinkId) {
    await deps.reject('payment_email_operation_mismatch')
  }
  if (delivery.status === 'sent' || delivery.status === 'sending') return
  if (delivery.status === 'failed' || delivery.status === 'ambiguous') {
    await deps.reject(`payment_email_${delivery.status}`)
  }
  await deps.enqueue({
    deliveryId: delivery.id,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
  })
}
