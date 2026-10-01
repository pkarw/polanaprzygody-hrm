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
