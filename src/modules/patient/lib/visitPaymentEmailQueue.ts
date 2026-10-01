export const VISIT_PAYMENT_EMAIL_QUEUE = 'patient-visit-payment-email'

/** Deliberately scalar-only: the worker authoritatively re-reads every mutable value. */
export type VisitPaymentEmailJob = {
  visitId: string
  paymentLinkId: string
  tenantId: string
  organizationId: string
}
