import { z } from 'zod'

export const publicBookingTag = 'Public booking'

export const publicBookingErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
}).passthrough()

export const publicBookingPriceSchema = z.object({
  currency: z.string(),
  amount: z.string(),
  wasAmount: z.string().optional(),
  isPromotion: z.boolean(),
})

export const publicBookingServiceSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  durationMinutes: z.number().int().positive(),
  category: z.string(),
  price: publicBookingPriceSchema,
})

export const publicBookingTherapistSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  photoUrl: z.string().url().optional(),
  shortBio: z.string().optional(),
  specializations: z.array(z.string()).optional(),
})

export const publicBookingAvailabilitySchema = z.object({
  slots: z.array(z.object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    timeZone: z.string(),
  })),
  degraded: z.literal(true).optional(),
})

export const publicBookingRequestBodySchema = z.object({
  productId: z.string().uuid(),
  teamMemberId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  timeZone: z.literal('Europe/Warsaw'),
  requester: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string().email().optional(),
    phone: z.string(),
  }),
  patient: z.object({
    firstName: z.string(),
    lastName: z.string(),
    address: z.object({
      street: z.string(),
      postalCode: z.string(),
      city: z.string(),
      country: z.string().length(2),
    }),
  }),
  consents: z.object({ terms: z.literal(true), privacyPolicy: z.literal(true) }),
})

export const publicBookingRequestSuccessSchema = z.object({ ok: z.literal(true) })

export const publicBookingProvenanceSchema = z.object({
  onlineBooking: z.object({
    submittedAt: z.string().datetime({ offset: true }),
    termsAcceptedAt: z.string().datetime({ offset: true }),
    privacyPolicyAcceptedAt: z.string().datetime({ offset: true }),
    confirmationEmailSentAt: z.string().datetime({ offset: true }).nullable(),
  }).nullable(),
})
