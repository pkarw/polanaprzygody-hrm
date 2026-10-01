import { createModuleQueue, type Queue } from '@open-mercato/queue'

export const PUBLIC_BOOKING_EMAIL_QUEUE = 'public-booking-email'

const PUBLIC_BOOKING_EMAIL_QUEUE_KEY = '__publicBookingConfirmationEmailQueue__' as const

/** Scalar-only payload; the worker re-reads every mutable and encrypted value. */
export type BookingConfirmationEmailJob = {
  deliveryId: string
  tenantId: string
  organizationId: string
}

/** Process-memoized so hot reloads and repeated dispatches share one queue client. */
export function getBookingConfirmationEmailQueue(): Queue<BookingConfirmationEmailJob> {
  const globalStore = globalThis as typeof globalThis & {
    [PUBLIC_BOOKING_EMAIL_QUEUE_KEY]?: Queue<BookingConfirmationEmailJob>
  }
  if (!globalStore[PUBLIC_BOOKING_EMAIL_QUEUE_KEY]) {
    globalStore[PUBLIC_BOOKING_EMAIL_QUEUE_KEY] = createModuleQueue<BookingConfirmationEmailJob>(
      PUBLIC_BOOKING_EMAIL_QUEUE,
      { concurrency: 5 },
    )
  }
  return globalStore[PUBLIC_BOOKING_EMAIL_QUEUE_KEY]
}
