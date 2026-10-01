import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { getSecurityEmailBaseUrl } from '@open-mercato/shared/lib/url'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Patient, PatientContactLink, PatientVisit } from '../data/entities'
import VisitPaymentLinkEmail from '../emails/VisitPaymentLinkEmail'
import {
  VISIT_PAYMENT_EMAIL_QUEUE,
  type VisitPaymentEmailJob,
} from '../lib/visitPaymentEmailQueue'
import { PATIENT_VISIT_ENTITY_ID } from '../lib/visitPaymentFields'

export const metadata: WorkerMeta = {
  queue: VISIT_PAYMENT_EMAIL_QUEUE,
  id: 'patient:visit-payment-link-email',
  concurrency: 5,
}

type Delivery = {
  recipient: string
  paymentUrl: string
}

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
): Promise<Delivery | null> {
  if (!payload.visitId || !payload.paymentLinkId || !payload.tenantId || !payload.organizationId) return null
  const scope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const visit = await em.findOne(PatientVisit, {
    id: payload.visitId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
  } as FilterQuery<PatientVisit>)
  if (!visit) return null

  const custom = await loadCustomFieldValues({
    em,
    entityId: PATIENT_VISIT_ENTITY_ID,
    recordIds: [payload.visitId],
    tenantIdByRecord: { [payload.visitId]: scope.tenantId },
    organizationIdByRecord: { [payload.visitId]: scope.organizationId },
  })
  const values = (custom[payload.visitId] ?? {}) as Record<string, unknown>
  const linkId = readString(values, 'cf_payment_link_id', 'cf:payment_link_id', 'payment_link_id')
  const slug = readString(values, 'cf_payment_link_slug', 'cf:payment_link_slug', 'payment_link_slug')
  const status = readString(values, 'cf_payment_link_status', 'cf:payment_link_status', 'payment_link_status')
  const receivedAt = readString(values, 'cf_payment_received_at', 'cf:payment_received_at', 'payment_received_at')
  if (linkId !== payload.paymentLinkId || !slug || receivedAt || status === 'completed') return null
  if (!['pending', 'processing'].includes(status ?? '')) return null

  const linkRows = await queryEngine.query<Record<string, unknown>>('checkout:checkout_link', {
    fields: ['id', 'slug', 'status'],
    filters: { id: { $eq: payload.paymentLinkId } },
    page: { page: 1, pageSize: 1 },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  const link = linkRows.items[0]
  if (!link || !['active', 'draft'].includes(String(link.status ?? '')) || String(link.slug ?? '') !== slug) return null

  const patient = await findOneWithDecryption(em, Patient, {
    id: visit.patientId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
  } as FilterQuery<Patient>, undefined, scope)
  if (!patient) return null
  const recipient = await resolveContactEmail(em, queryEngine, String(patient.id), scope)
    ?? (typeof patient.email === 'string' && patient.email.trim() ? patient.email.trim() : null)
  if (!recipient) return null

  return {
    recipient,
    paymentUrl: `${getSecurityEmailBaseUrl(undefined).replace(/\/$/, '')}/pay/${encodeURIComponent(slug)}`,
  }
}

export default async function handleVisitPaymentEmailJob(
  job: QueuedJob<VisitPaymentEmailJob>,
  _ctx: JobContext,
): Promise<void> {
  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const delivery = await loadVisitPaymentEmailDelivery(job.payload, em, queryEngine)
  if (!delivery) return
  const { t } = await resolveTranslations()
  await sendEmail({
    to: delivery.recipient,
    subject: t('patient.visits.payment.email.subject', 'Link do płatności za wizytę'),
    tenantId: job.payload.tenantId,
    organizationId: job.payload.organizationId,
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
