import { randomUUID } from 'node:crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { conflict } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { PatientVisitPaymentEmailDelivery } from '../data/entities'
import handleVisitPaymentEmailJob from '../workers/visit-payment-link-email'
import { requirePatientScope } from './commandSupport'
import type { VisitPaymentLink } from './visitPaymentLinkService'
import {
  getVisitPaymentEmailQueue,
  type VisitPaymentEmailJob,
} from './visitPaymentEmailQueue'
import { dispatchDurablePaymentEmailOperation } from './visitPaymentEmailOperation'
import { assertPaymentLinkCanBeEmailed } from './visitPaymentEmailPolicy'

const logger = createLogger('patient.visit_payment_email.dispatch')
const LOCAL_WORKER_PROMISE_KEY = '__patientVisitPaymentEmailLocalWorker__' as const

export type VisitPaymentLinkEmailService = {
  enqueueForVisit(
    visitId: string,
    paymentLink: VisitPaymentLink,
    operationKey: string,
    ctx: CommandRuntimeContext,
  ): Promise<void>
}

async function ensureLocalWorkerStarted(): Promise<void> {
  if (process.env.QUEUE_STRATEGY === 'async') return
  const globalStore = globalThis as typeof globalThis & {
    [LOCAL_WORKER_PROMISE_KEY]?: Promise<void>
  }
  if (!globalStore[LOCAL_WORKER_PROMISE_KEY]) {
    globalStore[LOCAL_WORKER_PROMISE_KEY] = getVisitPaymentEmailQueue()
      .process(handleVisitPaymentEmailJob)
      .then(() => undefined)
      .catch((error) => {
        delete globalStore[LOCAL_WORKER_PROMISE_KEY]
        logger.error('Failed to start local visit-payment-email worker', {
          errorName: error instanceof Error ? error.name : 'unknown',
        })
        throw error
      })
  }
  await globalStore[LOCAL_WORKER_PROMISE_KEY]
}

async function dispatchVisitPaymentEmailJob(payload: VisitPaymentEmailJob): Promise<void> {
  try {
    await getVisitPaymentEmailQueue().enqueue(payload)
    await ensureLocalWorkerStarted()
  } catch (error) {
    // `pending` was committed first, so the caller can retry with the same key.
    logger.error('Failed to enqueue visit-payment-email delivery', {
      deliveryId: payload.deliveryId,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      status: 'pending',
      errorName: error instanceof Error ? error.name : 'unknown',
    })
    throw error
  }
}

async function operationConflict(key: string, fallback: string, code: string): Promise<never> {
  const { translate } = await resolveTranslations()
  const error = conflict(translate(key, fallback))
  error.body.code = code
  throw error
}

async function findOrCreateDelivery(
  em: EntityManager,
  input: {
    visitId: string
    paymentLinkId: string
    operationKey: string
    tenantId: string
    organizationId: string
  },
): Promise<PatientVisitPaymentEmailDelivery> {
  const where = {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    operationKey: input.operationKey,
  } as FilterQuery<PatientVisitPaymentEmailDelivery>
  let delivery = await em.findOne(PatientVisitPaymentEmailDelivery, where)
  if (!delivery) {
    const now = new Date()
    delivery = em.create(PatientVisitPaymentEmailDelivery, {
      id: randomUUID(),
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      visitId: input.visitId,
      paymentLinkId: input.paymentLinkId,
      operationKey: input.operationKey,
      status: 'pending',
      claimedAt: null,
      sentAt: null,
      failedAt: null,
      failureCode: null,
      createdAt: now,
      updatedAt: now,
    })
    try {
      em.persist(delivery)
      await em.flush()
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) throw error
      delivery = await em.fork().findOne(PatientVisitPaymentEmailDelivery, where)
      if (!delivery) throw error
    }
  }
  return delivery
}

export function createVisitPaymentLinkEmailService(): VisitPaymentLinkEmailService {
  return {
    async enqueueForVisit(visitId, paymentLink, operationKey, ctx) {
      const scope = requirePatientScope(ctx)
      assertPaymentLinkCanBeEmailed(paymentLink)
      const em = (ctx.container.resolve('em') as EntityManager).fork()
      await dispatchDurablePaymentEmailOperation({
        visitId,
        paymentLinkId: paymentLink.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      }, {
        findOrCreate: () => findOrCreateDelivery(em, {
          visitId,
          paymentLinkId: paymentLink.id,
          operationKey,
          ...scope,
        }),
        enqueue: dispatchVisitPaymentEmailJob,
        reject: async (code) => {
          if (code === 'payment_email_operation_mismatch') {
            return await operationConflict(
              'patient.errors.paymentEmailOperationMismatch',
              'This email operation key was already used for another delivery',
              code,
            )
          }
          return await operationConflict(
            'patient.errors.paymentEmailOperationTerminal',
            'This email operation reached a terminal delivery state; start a new resend operation',
            code,
          )
        },
      })
    },
  }
}
