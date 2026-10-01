import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { POLANA_ROOM_ADDRESS } from '../../polana_bootstrap/resource-fixtures'
import {
  BookingIntake,
  type BookingConfirmationEmailDeliveryStatus,
} from '../data/entities'
import BookingConfirmedEmail from '../emails/BookingConfirmedEmail'
import {
  PUBLIC_BOOKING_EMAIL_QUEUE,
  type BookingConfirmationEmailJob,
} from '../lib/bookingConfirmationEmailQueue'
import {
  processBookingConfirmationDelivery,
  type BookingConfirmationDelivery,
  type BookingDeliveryLoadResult,
} from '../lib/bookingConfirmationEmailDelivery'

export const metadata: WorkerMeta = {
  queue: PUBLIC_BOOKING_EMAIL_QUEUE,
  id: 'public_booking:send-confirmation-email',
  concurrency: 5,
}

const logger = createLogger('public_booking.confirmation_email.worker')

function text(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export async function loadBookingConfirmationDelivery(
  payload: BookingConfirmationEmailJob,
  em: EntityManager,
  queryEngine: QueryEngine,
): Promise<BookingDeliveryLoadResult> {
  if (!payload.deliveryId || !payload.tenantId || !payload.organizationId) {
    return { ok: false, code: 'invalid_delivery_scope' }
  }
  const scope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const intake = await findOneWithDecryption(em, BookingIntake, {
    id: payload.deliveryId,
    ...scope,
    deletedAt: null,
  } as FilterQuery<BookingIntake>, undefined, scope)
  if (!intake) return { ok: false, code: 'intake_missing' }
  if (!intake.requesterEmailSnapshot?.trim()) return { ok: false, code: 'recipient_missing' }

  const visits = await queryEngine.query<Record<string, unknown>>('patient:patient_visit', {
    fields: ['id', 'starts_at', 'time_zone', 'resource_name_snapshot', 'confirmed_at', 'deleted_at'],
    filters: { id: { $eq: intake.visitId }, deleted_at: null },
    page: { page: 1, pageSize: 1 },
    ...scope,
  })
  const visit = visits.items[0]
  if (!visit) return { ok: false, code: 'visit_missing' }
  const confirmedAt = visit.confirmed_at ?? visit.confirmedAt
  if (!confirmedAt) return { ok: false, code: 'visit_unconfirmed' }
  const startsAtValue = visit.starts_at ?? visit.startsAt
  const startsAt = startsAtValue instanceof Date ? startsAtValue : new Date(String(startsAtValue ?? ''))
  const room = text(visit, 'resource_name_snapshot', 'resourceNameSnapshot')
  if (Number.isNaN(startsAt.getTime()) || !room) {
    return { ok: false, code: 'visit_delivery_details_missing' }
  }

  const products = await queryEngine.query<Record<string, unknown>>('catalog:catalog_product', {
    fields: ['id', 'title', 'is_active', 'deleted_at'],
    filters: { id: { $eq: intake.productId } },
    page: { page: 1, pageSize: 1 },
    ...scope,
    withDeleted: true,
  })
  const service = products.items[0] ? text(products.items[0], 'title') : null
  if (!service) return { ok: false, code: 'service_missing' }
  return {
    ok: true,
    delivery: {
      recipient: intake.requesterEmailSnapshot.trim(),
      requesterName: intake.requesterNameSnapshot,
      service,
      startsAt,
      timeZone: text(visit, 'time_zone', 'timeZone') ?? 'Europe/Warsaw',
      room,
    },
  }
}

function formatDeliveryDate(startsAt: Date, timeZone: string): { date: string; time: string } {
  return {
    date: new Intl.DateTimeFormat('pl-PL', { dateStyle: 'long', timeZone }).format(startsAt),
    time: new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone }).format(startsAt),
  }
}

async function transitionBookingDelivery(
  rootEm: EntityManager,
  payload: BookingConfirmationEmailJob,
  from: BookingConfirmationEmailDeliveryStatus,
  to: BookingConfirmationEmailDeliveryStatus,
  code?: string,
): Promise<boolean> {
  const em = rootEm.fork()
  await em.begin()
  try {
    const now = new Date()
    const changed = await em.nativeUpdate(BookingIntake, {
      id: payload.deliveryId,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      deletedAt: null,
      confirmationEmailDeliveryStatus: from,
    } as FilterQuery<BookingIntake>, {
      confirmationEmailDeliveryStatus: to,
      confirmationEmailClaimedAt: to === 'sending' ? now : undefined,
      confirmationEmailSentAt: to === 'sent' ? now : undefined,
      confirmationEmailFailedAt: to === 'failed' || to === 'ambiguous' ? now : undefined,
      confirmationEmailFailureCode: code ?? null,
      updatedAt: now,
    })
    await em.commit()
    return changed === 1
  } catch (error) {
    await em.rollback()
    throw error
  }
}

async function readBookingDeliveryStatus(
  em: EntityManager,
  payload: BookingConfirmationEmailJob,
): Promise<BookingConfirmationEmailDeliveryStatus | null> {
  const intake = await em.findOne(BookingIntake, {
    id: payload.deliveryId,
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    deletedAt: null,
  } as FilterQuery<BookingIntake>, { fields: ['confirmationEmailDeliveryStatus'] })
  return intake?.confirmationEmailDeliveryStatus ?? null
}

async function sendBookingConfirmationEmail(
  delivery: BookingConfirmationDelivery,
  payload: BookingConfirmationEmailJob,
): Promise<void> {
  const { date, time } = formatDeliveryDate(delivery.startsAt, delivery.timeZone)
  const { t } = await resolveTranslations()
  await sendEmail({
    to: delivery.recipient,
    subject: t('public_booking.email.subject', 'Potwierdzenie wizyty — Polana Przygody'),
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    react: BookingConfirmedEmail({
      requesterName: delivery.requesterName,
      service: delivery.service,
      date,
      time,
      room: delivery.room,
      address: `${POLANA_ROOM_ADDRESS.street}, ${POLANA_ROOM_ADDRESS.postalCode} ${POLANA_ROOM_ADDRESS.city}`,
      copy: {
        preview: t('public_booking.email.preview', 'Wizyta w Polanie Przygody została potwierdzona'),
        heading: t('public_booking.email.heading', 'Wizyta potwierdzona'),
        greeting: t('public_booking.email.greeting', 'Dzień dobry'),
        body: t('public_booking.email.body', 'Rejestracja potwierdziła termin wizyty. Poniżej znajdziesz najważniejsze informacje.'),
        serviceLabel: t('public_booking.email.service', 'Usługa'),
        dateLabel: t('public_booking.email.date', 'Data'),
        timeLabel: t('public_booking.email.time', 'Godzina'),
        roomLabel: t('public_booking.email.room', 'Gabinet'),
        addressLabel: t('public_booking.email.address', 'Adres'),
        footer: t('public_booking.email.footer', 'W razie pytań skontaktuj się z rejestracją: +48 790 512 258.'),
      },
    }),
  })
}

export default async function handleBookingConfirmationEmailJob(
  job: QueuedJob<BookingConfirmationEmailJob>,
  _ctx: JobContext,
): Promise<void> {
  const container = await createRequestContainer()
  const rootEm = container.resolve('em') as EntityManager
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const payload = job.payload
  await processBookingConfirmationDelivery({
    readStatus: () => readBookingDeliveryStatus(rootEm.fork(), payload),
    loadDelivery: () => loadBookingConfirmationDelivery(payload, rootEm.fork(), queryEngine),
    claimSending: () => transitionBookingDelivery(rootEm, payload, 'pending', 'sending'),
    markSent: () => transitionBookingDelivery(rootEm, payload, 'sending', 'sent'),
    markFailed: (code) => transitionBookingDelivery(rootEm, payload, 'pending', 'failed', code),
    markAmbiguous: (code) => transitionBookingDelivery(rootEm, payload, 'sending', 'ambiguous', code),
    send: (delivery) => sendBookingConfirmationEmail(delivery, payload),
    logTerminal: (status, code, errorName) => {
      logger.error('Confirmation-email delivery reached a terminal state', {
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
