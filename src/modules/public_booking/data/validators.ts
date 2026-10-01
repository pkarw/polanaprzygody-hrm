import { z } from 'zod'

const boundedText = (max: number) => z.string().trim().min(1).max(max)

export const bookingConsentDocumentSchema = z.object({
  url: z.string().url().max(2_048),
  acceptedAt: z.string().datetime({ offset: true }),
}).strict()

export const bookingConsentProofSchema = z.object({
  terms: bookingConsentDocumentSchema,
  privacyPolicy: bookingConsentDocumentSchema,
}).strict()

export const bookingIntakeRecordSchema = z.object({
  visitId: z.string().uuid(),
  customerEntityId: z.string().uuid(),
  patientId: z.string().uuid(),
  productId: z.string().uuid(),
  requesterNameSnapshot: boundedText(240),
  requesterEmailSnapshot: z.string().trim().toLowerCase().email().max(320).nullish(),
  requesterPhoneSnapshot: boundedText(40),
  consentProof: bookingConsentProofSchema,
  clientIdempotencyKey: boundedText(128).refine((value) => value.length >= 16),
  requestPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

export const serviceCredentialInputSchema = z.object({
  serviceUserId: z.string().uuid(),
  apiKeyId: z.string().uuid(),
  apiKeySecret: boundedText(512),
}).strict()

export const publicBookingAvailabilityQuerySchema = z.object({
  productId: z.string().uuid(),
  teamMemberId: z.string().uuid(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
}).strict()

const personName = boundedText(120)

export const publicBookingRequestSchema = z.object({
  productId: z.string().uuid(),
  teamMemberId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  timeZone: z.literal('Europe/Warsaw'),
  requester: z.object({
    firstName: personName,
    lastName: personName,
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    phone: boundedText(40),
  }).strict(),
  patient: z.object({
    firstName: personName,
    lastName: personName,
    address: z.object({
      street: boundedText(300),
      postalCode: boundedText(30),
      city: boundedText(160),
      country: boundedText(2).transform((value) => value.toUpperCase()),
    }).strict(),
  }).strict(),
  consents: z.object({
    terms: z.literal(true),
    privacyPolicy: z.literal(true),
  }).strict(),
}).strict()

export type BookingIntakeRecordInput = z.infer<typeof bookingIntakeRecordSchema>
export type ServiceCredentialInput = z.infer<typeof serviceCredentialInputSchema>
export type PublicBookingAvailabilityQuery = z.infer<typeof publicBookingAvailabilityQuerySchema>
export type PublicBookingRequest = z.infer<typeof publicBookingRequestSchema>
