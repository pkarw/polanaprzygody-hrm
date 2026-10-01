import { createQueue } from '@open-mercato/queue'
import type { JobContext, QueuedJob } from '@open-mercato/queue'
import handleBookingConfirmationEmailJob from '../workers/send-email.worker'
import {
  PUBLIC_BOOKING_EMAIL_QUEUE,
  type BookingConfirmationEmailJob,
} from './bookingConfirmationEmailQueue'

export async function dispatchBookingConfirmationEmailJob(
  payload: BookingConfirmationEmailJob,
): Promise<void> {
  if (process.env.QUEUE_STRATEGY === 'async') {
    await createQueue<BookingConfirmationEmailJob>(PUBLIC_BOOKING_EMAIL_QUEUE, 'async').enqueue(payload)
    return
  }
  const job: QueuedJob<BookingConfirmationEmailJob> = {
    id: `inline-${Date.now()}`,
    payload,
    createdAt: new Date().toISOString(),
  }
  const context: JobContext = {
    jobId: job.id,
    attemptNumber: 1,
    queueName: PUBLIC_BOOKING_EMAIL_QUEUE,
  }
  await handleBookingConfirmationEmailJob(job, context)
}
