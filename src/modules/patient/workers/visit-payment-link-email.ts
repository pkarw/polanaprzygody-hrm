import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { AbandonedJobInfo, JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { getSecurityEmailBaseUrl } from '@open-mercato/shared/lib/url'
import {
  Patient,
  PatientContactLink,
  PatientVisit,
  PatientVisitPaymentEmailDelivery,
  type PatientVisitPaymentEmailDeliveryStatus,
} from '../data/entities'
import VisitPaymentLinkEmail from '../emails/VisitPaymentLinkEmail'
import {
  VISIT_PAYMENT_EMAIL_QUEUE,
  type VisitPaymentEmailJob,
} from '../lib/visitPaymentEmailQueue'
import {
  processVisitPaymentEmailDelivery,
  recoverAbandonedVisitPaymentEmail,
  type VisitPaymentEmailDelivery,
  type VisitPaymentEmailDeliveryState,
  type VisitPaymentEmailLoadResult,
} from '../lib/visitPaymentEmailDelivery'
import { PATIENT_VISIT_ENTITY_ID } from '../lib/visitPaymentFields'

export const metadata: WorkerMeta = {
  queue: VISIT_PAYMENT_EMAIL_QUEUE,
  id: 'patient:visit-payment-link-email',
  concurrency: 5,
  onJobAbandoned: handleAbandonedVisitPaymentEmailJob,
}

const logger = createLogger('patient.visit_payment_email.worker')

function readString(values: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = values[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

async function resolveContactEmail(
  em: EntityManager,
  queryEngine: QueryEngine,
  patientId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<string | null> {
  const links = await em.find(PatientContactLink, {
    patientId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
    isContact: true,
  } as FilterQuery<PatientContactLink>, {
    orderBy: { isPrimaryContact: 'desc', isPayer: 'desc', createdAt: 'asc' },
  })
  if (links.length === 0) return null
  const ids = links.map((link) => String(link.customerEntityId))
  const result = await queryEngine.query<Record<string, unknown>>('customers:customer_entity', {
    fields: ['id', 'primary_email', 'is_active', 'deleted_at'],
    filters: { id: { $in: ids }, kind: { $eq: 'person' } },
    page: { page: 1, pageSize: ids.length },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    withDeleted: true,
  })
  const byId = new Map(result.items.map((item) => [String(item.id ?? ''), item]))
  for (const id of ids) {
    const row = byId.get(id)
    if (!row || row.is_active === false || row.deleted_at) continue
    const email = readString(row, 'primary_email', 'primaryEmail')
    if (email) return email
  }
  return null
}

export async function loadVisitPaymentEmailDelivery(
  payload: VisitPaymentEmailJob,
  em: EntityManager,
  queryEngine: QueryEngine,
): Promise<VisitPaymentEmailLoadResult> {
  if (!payload.deliveryId || !payload.tenantId || !payload.organizationId) {
    return { ok: false, code: 'invalid_delivery_scope' }
  }
  const scope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const operation = await em.findOne(PatientVisitPaymentEmailDelivery, {
    id: payload.deliveryId,
    ...scope,
  } as FilterQuery<PatientVisitPaymentEmailDelivery>)
  if (!operation) return { ok: false, code: 'delivery_missing' }
  const visit = await em.findOne(PatientVisit, {
    id: operation.visitId,
    ...scope,
    deletedAt: null,
  } as FilterQuery<PatientVisit>)
  if (!visit) return { ok: false, code: 'visit_missing' }

  const custom = await loadCustomFieldValues({
    em,
    entityId: PATIENT_VISIT_ENTITY_ID,
    recordIds: [operation.visitId],
    tenantIdByRecord: { [operation.visitId]: scope.tenantId },
    organizationIdByRecord: { [operation.visitId]: scope.organizationId },
  })
  const values = (custom[operation.visitId] ?? {}) as Record<string, unknown>
  const linkId = readString(values, 'cf_payment_link_id', 'cf:payment_link_id', 'payment_link_id')
  const slug = readString(values, 'cf_payment_link_slug', 'cf:payment_link_slug', 'payment_link_slug')
  const status = readString(values, 'cf_payment_link_status', 'cf:payment_link_status', 'payment_link_status')
  const receivedAt = readString(values, 'cf_payment_received_at', 'cf:payment_received_at', 'payment_received_at')
  if (linkId !== operation.paymentLinkId || !slug) {
    return { ok: false, code: 'payment_link_missing' }
  }
  if (receivedAt || status === 'completed') return { ok: false, code: 'payment_link_completed' }
  if (!['pending', 'processing'].includes(status ?? '')) {
    return { ok: false, code: 'payment_link_inactive' }
  }

  const linkRows = await queryEngine.query<Record<string, unknown>>('checkout:checkout_link', {
    fields: ['id', 'slug', 'status'],
    filters: { id: { $eq: operation.paymentLinkId } },
    page: { page: 1, pageSize: 1 },
    ...scope,
  })
  const link = linkRows.items[0]
  if (!link || !['active', 'draft'].includes(String(link.status ?? '')) || String(link.slug ?? '') !== slug) {
    return { ok: false, code: 'checkout_link_inactive' }
  }

  const patient = await findOneWithDecryption(em, Patient, {
    id: visit.patientId,
    ...scope,
    deletedAt: null,
  } as FilterQuery<Patient>, undefined, scope)
  if (!patient) return { ok: false, code: 'patient_missing' }
  const recipient = await resolveContactEmail(em, queryEngine, String(patient.id), scope)
    ?? (typeof patient.email === 'string' && patient.email.trim() ? patient.email.trim() : null)
  if (!recipient) return { ok: false, code: 'recipient_missing' }

  return {
    ok: true,
    delivery: {
      recipient,
      paymentUrl: `${getSecurityEmailBaseUrl(undefined).replace(/\/$/, '')}/pay/${encodeURIComponent(slug)}`,
    },
  }
}

async function transitionVisitPaymentEmailDelivery(
  rootEm: EntityManager,
  payload: VisitPaymentEmailJob,
  from: PatientVisitPaymentEmailDeliveryStatus,
  to: PatientVisitPaymentEmailDeliveryStatus,
  code?: string,
  expectedClaimJobId?: string | null,
  nextClaimJobId?: string,
): Promise<boolean> {
  const em = rootEm.fork()
  await em.begin()
  try {
    const now = new Date()
    const where = {
      id: payload.deliveryId,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      status: from,
      ...(expectedClaimJobId !== undefined ? { claimJobId: expectedClaimJobId } : {}),
    } as FilterQuery<PatientVisitPaymentEmailDelivery>
    const changed = await em.nativeUpdate(PatientVisitPaymentEmailDelivery, where, {
      status: to,
      ...(nextClaimJobId !== undefined ? { claimJobId: nextClaimJobId } : {}),
      claimedAt: to === 'sending' ? now : undefined,
      sentAt: to === 'sent' ? now : undefined,
      failedAt: to === 'failed' || to === 'ambiguous' ? now : undefined,
      failureCode: code ?? null,
      updatedAt: now,
    })
    await em.commit()
    return changed === 1
  } catch (error) {
    await em.rollback()
    throw error
  }
}

async function readDeliveryState(
  em: EntityManager,
  payload: VisitPaymentEmailJob,
): Promise<VisitPaymentEmailDeliveryState | null> {
  const delivery = await em.findOne(PatientVisitPaymentEmailDelivery, {
    id: payload.deliveryId,
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  } as FilterQuery<PatientVisitPaymentEmailDelivery>, { fields: ['status', 'claimJobId'] })
  return delivery ? { status: delivery.status, claimJobId: delivery.claimJobId ?? null } : null
}

async function sendVisitPaymentEmail(delivery: VisitPaymentEmailDelivery, payload: VisitPaymentEmailJob): Promise<void> {
  const { t } = await resolveTranslations()
  await sendEmail({
    to: delivery.recipient,
    subject: t('patient.visits.payment.email.subject', 'Link do płatności za wizytę'),
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    react: VisitPaymentLinkEmail({
      paymentUrl: delivery.paymentUrl,
      copy: {
        preview: t('patient.visits.payment.email.preview', 'Bezpieczny link do płatności online'),
        heading: t('patient.visits.payment.email.heading', 'Płatność za wizytę'),
        greeting: t('patient.visits.payment.email.greeting', 'Dzień dobry,'),
        body: t('patient.visits.payment.email.body', 'Poniżej znajduje się link do bezpiecznej płatności za wizytę w Polanie Przygody.'),
        cta: t('patient.visits.payment.email.cta', 'Przejdź do płatności'),
        securityHint: t('patient.visits.payment.email.securityHint', 'Jeżeli nie oczekujesz tej wiadomości, nie otwieraj linku i skontaktuj się z recepcją.'),
        footer: t('patient.visits.payment.email.footer', 'Polana Przygody'),
      },
    }),
  })
}

export default async function handleVisitPaymentEmailJob(
  job: QueuedJob<VisitPaymentEmailJob>,
  ctx: JobContext,
): Promise<void> {
  const container = await createRequestContainer()
  const rootEm = container.resolve('em') as EntityManager
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const payload = job.payload
  await processVisitPaymentEmailDelivery({
    jobId: ctx.jobId,
    readState: () => readDeliveryState(rootEm.fork(), payload),
    loadDelivery: () => loadVisitPaymentEmailDelivery(payload, rootEm.fork(), queryEngine),
    claimSending: (jobId) => transitionVisitPaymentEmailDelivery(
      rootEm, payload, 'pending', 'sending', undefined, null, jobId,
    ),
    markSent: (jobId) => transitionVisitPaymentEmailDelivery(
      rootEm, payload, 'sending', 'sent', undefined, jobId,
    ),
    markFailed: (code) => transitionVisitPaymentEmailDelivery(rootEm, payload, 'pending', 'failed', code),
    markAmbiguous: (jobId, code) => transitionVisitPaymentEmailDelivery(
      rootEm, payload, 'sending', 'ambiguous', code, jobId,
    ),
    send: (delivery) => sendVisitPaymentEmail(delivery, payload),
    logTerminal: (status, code, errorName) => {
      logger.error('Visit-payment-email delivery reached a terminal state', {
        deliveryId: payload.deliveryId,
        tenantId: payload.tenantId,
        organizationId: payload.organizationId,
        status,
        code,
        ...(errorName ? { errorName } : {}),
      })
    },
  })
}

function isVisitPaymentEmailJob(payload: unknown): payload is VisitPaymentEmailJob {
  if (!payload || typeof payload !== 'object') return false
  const candidate = payload as Record<string, unknown>
  return typeof candidate.deliveryId === 'string'
    && typeof candidate.tenantId === 'string'
    && typeof candidate.organizationId === 'string'
}

export async function handleAbandonedVisitPaymentEmailJob(
  rawPayload: unknown,
  info: AbandonedJobInfo,
): Promise<void> {
  if (!isVisitPaymentEmailJob(rawPayload)) return
  const payload = rawPayload
  const container = await createRequestContainer()
  const rootEm = container.resolve('em') as EntityManager
  await recoverAbandonedVisitPaymentEmail(info.jobId, {
    markPendingFailed: (code) => transitionVisitPaymentEmailDelivery(
      rootEm, payload, 'pending', 'failed', code,
    ),
    markOwnedSendingAmbiguous: (jobId, code) => transitionVisitPaymentEmailDelivery(
      rootEm, payload, 'sending', 'ambiguous', code, jobId,
    ),
    logTerminal: (status, code) => {
      logger.error('Visit-payment-email delivery recovered from an abandoned queue job', {
        deliveryId: payload.deliveryId,
        tenantId: payload.tenantId,
        organizationId: payload.organizationId,
        jobId: info.jobId,
        status,
        code,
      })
    },
  })
}
