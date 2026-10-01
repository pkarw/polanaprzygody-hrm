export const PUBLIC_BOOKING_EMAIL_QUEUE = 'public-booking-email'

/** Scalar-only payload; the worker re-reads every mutable and encrypted value. */
export type BookingConfirmationEmailJob = {
  visitId: string
  tenantId: string
  organizationId: string
}
