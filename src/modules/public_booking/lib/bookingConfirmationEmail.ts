import { createLogger } from '@open-mercato/shared/lib/logger'
import handleBookingConfirmationEmailJob from '../workers/send-email.worker'
import {
  getBookingConfirmationEmailQueue,
  type BookingConfirmationEmailJob,
} from './bookingConfirmationEmailQueue'

const logger = createLogger('public_booking.confirmation_email.dispatch')
const LOCAL_WORKER_PROMISE_KEY = '__publicBookingConfirmationEmailLocalWorker__' as const

async function ensureLocalWorkerStarted(): Promise<void> {
  if (process.env.QUEUE_STRATEGY === 'async') return
  const globalStore = globalThis as typeof globalThis & {
    [LOCAL_WORKER_PROMISE_KEY]?: Promise<void>
  }
  if (!globalStore[LOCAL_WORKER_PROMISE_KEY]) {
    globalStore[LOCAL_WORKER_PROMISE_KEY] = getBookingConfirmationEmailQueue()
      .process(handleBookingConfirmationEmailJob)
      .then(() => undefined)
      .catch((error) => {
        delete globalStore[LOCAL_WORKER_PROMISE_KEY]
        logger.error('Failed to start local confirmation-email worker', {
          errorName: error instanceof Error ? error.name : 'unknown',
        })
        throw error
      })
  }
  await globalStore[LOCAL_WORKER_PROMISE_KEY]
}

export async function dispatchBookingConfirmationEmailJob(
  payload: BookingConfirmationEmailJob,
): Promise<void> {
  try {
    await getBookingConfirmationEmailQueue().enqueue(payload)
    await ensureLocalWorkerStarted()
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
