import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  getBookingConfirmationEmailQueue,
  type BookingConfirmationEmailJob,
} from './bookingConfirmationEmailQueue'

const logger = createLogger('public_booking.confirmation_email.dispatch')
export async function dispatchBookingConfirmationEmailJob(
  payload: BookingConfirmationEmailJob,
): Promise<void> {
  try {
    await getBookingConfirmationEmailQueue().enqueue(payload)
  } catch (error) {
    // The durable row remains pending, so a persistent-event retry or explicit
    // redispatch can recover the exact same operation.
    logger.error('Failed to enqueue confirmation-email delivery', {
      deliveryId: payload.deliveryId,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      status: 'pending',
      errorName: error instanceof Error ? error.name : 'unknown',
    })
    throw error
  }
}
