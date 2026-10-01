import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { POLANA_ROOM_ADDRESS } from '../../polana_bootstrap/resource-fixtures'
import { BookingIntake } from '../data/entities'
import BookingConfirmedEmail from '../emails/BookingConfirmedEmail'
import {
  PUBLIC_BOOKING_EMAIL_QUEUE,
  type BookingConfirmationEmailJob,
} from '../lib/bookingConfirmationEmailQueue'

export const metadata: WorkerMeta = {
  queue: PUBLIC_BOOKING_EMAIL_QUEUE,
  id: 'public_booking:send-confirmation-email',
  concurrency: 5,
}

type BookingConfirmationDelivery = {
  recipient: string
  requesterName: string
  service: string
  startsAt: Date
  timeZone: string
  room: string
}

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
): Promise<BookingConfirmationDelivery | null> {
  if (!payload.visitId || !payload.tenantId || !payload.organizationId) return null
  const scope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const intake = await findOneWithDecryption(em, BookingIntake, {
    visitId: payload.visitId,
    ...scope,
    deletedAt: null,
  } as FilterQuery<BookingIntake>, undefined, scope)
  if (!intake || intake.confirmationEmailSentAt || !intake.requesterEmailSnapshot?.trim()) return null

  const visits = await queryEngine.query<Record<string, unknown>>('patient:patient_visit', {
    fields: ['id', 'starts_at', 'time_zone', 'resource_name_snapshot', 'confirmed_at', 'deleted_at'],
    filters: { id: { $eq: payload.visitId }, deleted_at: null },
    page: { page: 1, pageSize: 1 },
    ...scope,
  })
  const visit = visits.items[0]
  const startsAtValue = visit ? (visit.starts_at ?? visit.startsAt) : null
  const confirmedAt = visit ? (visit.confirmed_at ?? visit.confirmedAt) : null
  const startsAt = startsAtValue instanceof Date ? startsAtValue : new Date(String(startsAtValue ?? ''))
  const room = visit ? text(visit, 'resource_name_snapshot', 'resourceNameSnapshot') : null
  if (!visit || !confirmedAt || Number.isNaN(startsAt.getTime()) || !room) return null

  const products = await queryEngine.query<Record<string, unknown>>('catalog:catalog_product', {
    fields: ['id', 'title', 'is_active', 'deleted_at'],
    filters: { id: { $eq: intake.productId } },
    page: { page: 1, pageSize: 1 },
    ...scope,
    withDeleted: true,
  })
  const service = products.items[0] ? text(products.items[0], 'title') : null
  if (!service) return null
  return {
    recipient: intake.requesterEmailSnapshot.trim(),
    requesterName: intake.requesterNameSnapshot,
    service,
    startsAt,
    timeZone: text(visit, 'time_zone', 'timeZone') ?? 'Europe/Warsaw',
    room,
  }
}

function formatDeliveryDate(startsAt: Date, timeZone: string): { date: string; time: string } {
  return {
    date: new Intl.DateTimeFormat('pl-PL', { dateStyle: 'long', timeZone }).format(startsAt),
    time: new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone }).format(startsAt),
  }
}

export default async function handleBookingConfirmationEmailJob(
  job: QueuedJob<BookingConfirmationEmailJob>,
  _ctx: JobContext,
): Promise<void> {
  const container = await createRequestContainer()
  const rootEm = container.resolve('em') as EntityManager
  const queryEngine = container.resolve('queryEngine') as QueryEngine
  const lockEm = rootEm.fork()
  await lockEm.begin()
  try {
    await lockEm.execute('select pg_advisory_xact_lock(hashtextextended(?::text, 0))', [
      `public-booking-email:${job.payload.tenantId}:${job.payload.organizationId}:${job.payload.visitId}`,
    ])
    const marker = await lockEm.findOne(BookingIntake, {
      visitId: job.payload.visitId,
      tenantId: job.payload.tenantId,
      organizationId: job.payload.organizationId,
      deletedAt: null,
    } as FilterQuery<BookingIntake>, { fields: ['id', 'confirmationEmailSentAt'] })
    if (!marker || marker.confirmationEmailSentAt) {
      await lockEm.commit()
      return
    }
    const delivery = await loadBookingConfirmationDelivery(job.payload, rootEm.fork(), queryEngine)
    if (!delivery) {
      await lockEm.commit()
      return
    }
    const { date, time } = formatDeliveryDate(delivery.startsAt, delivery.timeZone)
    const { t } = await resolveTranslations()
    await sendEmail({
      to: delivery.recipient,
      subject: t('public_booking.email.subject', 'Potwierdzenie wizyty — Polana Przygody'),
      tenantId: job.payload.tenantId,
      organizationId: job.payload.organizationId,
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
    await lockEm.nativeUpdate(BookingIntake, { id: marker.id, confirmationEmailSentAt: null }, {
      confirmationEmailSentAt: new Date(),
      updatedAt: new Date(),
    })
    await lockEm.commit()
  } catch (error) {
    await lockEm.rollback()
    throw error
  }
}
