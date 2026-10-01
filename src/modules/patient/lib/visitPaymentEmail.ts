import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createQueue } from '@open-mercato/queue'
import type { JobContext, QueuedJob } from '@open-mercato/queue'
import type { VisitPaymentLink } from './visitPaymentLinkService'
import handleVisitPaymentEmailJob from '../workers/visit-payment-link-email'
import { requirePatientScope } from './commandSupport'
import { VISIT_PAYMENT_EMAIL_QUEUE, type VisitPaymentEmailJob } from './visitPaymentEmailQueue'
import { assertPaymentLinkCanBeEmailed } from './visitPaymentEmailPolicy'

export type VisitPaymentLinkEmailService = {
  enqueueForVisit(
    visitId: string,
    paymentLink: VisitPaymentLink,
    ctx: CommandRuntimeContext,
  ): Promise<void>
}

async function dispatchVisitPaymentEmailJob(payload: VisitPaymentEmailJob): Promise<void> {
  if (process.env.QUEUE_STRATEGY === 'async') {
    await createQueue<VisitPaymentEmailJob>(VISIT_PAYMENT_EMAIL_QUEUE, 'async').enqueue(payload)
    return
  }

  const job: QueuedJob<VisitPaymentEmailJob> = {
    id: `inline-${Date.now()}`,
    payload,
    createdAt: new Date().toISOString(),
  }
  const jobContext: JobContext = {
    jobId: job.id,
    attemptNumber: 1,
    queueName: VISIT_PAYMENT_EMAIL_QUEUE,
  }
  await handleVisitPaymentEmailJob(job, jobContext)
}

export function createVisitPaymentLinkEmailService(): VisitPaymentLinkEmailService {
  return {
    async enqueueForVisit(visitId, paymentLink, ctx) {
      const scope = requirePatientScope(ctx)
      assertPaymentLinkCanBeEmailed(paymentLink)
      await dispatchVisitPaymentEmailJob({
        visitId,
        paymentLinkId: paymentLink.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
    },
  }
}
