import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { BookingIntake } from '../data/entities'
import { dispatchBookingConfirmationEmailJob } from '../lib/bookingConfirmationEmail'

export const metadata = {
  event: 'patient.visit.confirmed',
  persistent: true,
  id: 'public_booking:visit-confirmed-email',
}

export type PatientVisitConfirmedPayload = {
  id?: string
  tenantId?: string | null
  organizationId?: string | null
}

export default async function onPatientVisitConfirmed(
  payload: PatientVisitConfirmedPayload,
): Promise<void> {
  if (!payload.id || !payload.tenantId || !payload.organizationId) return
  const scope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  const intake = await em.findOne(BookingIntake, {
    visitId: payload.id,
    ...scope,
    deletedAt: null,
  } as FilterQuery<BookingIntake>, { fields: ['id', 'confirmationEmailSentAt'] })
  // Staff-created visits have no intake and keep their existing behavior.
  if (!intake || intake.confirmationEmailSentAt) return
  await dispatchBookingConfirmationEmailJob({ visitId: payload.id, ...scope })
}
