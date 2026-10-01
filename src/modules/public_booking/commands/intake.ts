import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { BookingIntake } from '../data/entities'
import { bookingIntakeRecordSchema } from '../data/validators'
import { emitPublicBookingEvent } from '../events'
import {
  encryptPublicBookingFields,
  requirePublicBookingScope,
  resolvePublicBookingEncryption,
  type PublicBookingScope,
} from '../lib/commandSupport'

const BOOKING_INTAKE_ENTITY_ID = 'public_booking:booking_intake' as const

async function resolveIdempotentIntake(
  em: EntityManager,
  scope: PublicBookingScope,
  clientIdempotencyKey: string,
  requestPayloadHash: string,
): Promise<BookingIntake | null> {
  const existing = await em.findOne(BookingIntake, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    clientIdempotencyKey,
  } as FilterQuery<BookingIntake>)
  if (!existing) return null
  if (existing.requestPayloadHash !== requestPayloadHash) {
    throw new CrudHttpError(409, {
      error: 'This idempotency key was already used with different content',
      code: 'idempotency_payload_mismatch',
    })
  }
  return existing
}

export const recordBookingIntakeCommand: CommandHandler<Record<string, unknown>, BookingIntake> = {
  id: 'public_booking.intake.record',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = bookingIntakeRecordSchema.parse(rawInput)
    const scope = requirePublicBookingScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const replay = await resolveIdempotentIntake(
      em,
      scope,
      parsed.clientIdempotencyKey,
      parsed.requestPayloadHash,
    )
    if (replay) return replay

    const encrypted = await encryptPublicBookingFields(
      BOOKING_INTAKE_ENTITY_ID,
      {
        requesterNameSnapshot: parsed.requesterNameSnapshot,
        requesterEmailSnapshot: parsed.requesterEmailSnapshot ?? null,
        requesterPhoneSnapshot: parsed.requesterPhoneSnapshot,
        consentProof: JSON.stringify(parsed.consentProof),
      },
      scope,
      resolvePublicBookingEncryption(ctx),
    )
    const now = new Date()
    const intake = em.create(BookingIntake, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      visitId: parsed.visitId,
      customerEntityId: parsed.customerEntityId,
      patientId: parsed.patientId,
      productId: parsed.productId,
      requesterNameSnapshot: encrypted.requesterNameSnapshot,
      requesterEmailSnapshot: encrypted.requesterEmailSnapshot,
      requesterPhoneSnapshot: encrypted.requesterPhoneSnapshot,
      consentProof: encrypted.consentProof,
      clientIdempotencyKey: parsed.clientIdempotencyKey,
      requestPayloadHash: parsed.requestPayloadHash,
      submittedAt: now,
      confirmationEmailSentAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })

    try {
      em.persist(intake)
      await em.flush()
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        const raced = await resolveIdempotentIntake(
          (ctx.container.resolve('em') as EntityManager).fork(),
          scope,
          parsed.clientIdempotencyKey,
          parsed.requestPayloadHash,
        )
        if (raced) return raced
      }
      throw error
    }

    await emitPublicBookingEvent('public_booking.intake.submitted', {
      id: intake.id,
      visitId: intake.visitId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      createdAt: intake.createdAt.toISOString(),
    })
    return intake
  },
}

registerCommand(recordBookingIntakeCommand)
