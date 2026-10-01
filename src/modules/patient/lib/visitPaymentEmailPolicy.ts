import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { VisitPaymentLink } from './visitPaymentLinkService'

export function assertPaymentLinkCanBeEmailed(paymentLink: VisitPaymentLink): void {
  if (paymentLink.status === 'completed') {
    throw new CrudHttpError(409, {
      error: 'A completed payment link cannot be sent again',
      code: 'payment_link_completed',
    })
  }
  if (['inactive', 'expired', 'cancelled'].includes(paymentLink.status)) {
    throw new CrudHttpError(409, {
      error: 'An inactive payment link cannot be sent',
      code: 'payment_link_inactive',
    })
  }
}
