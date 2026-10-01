import { createLogger } from '@open-mercato/shared/lib/logger'
import { readEndpointRateLimitConfig } from '@open-mercato/shared/lib/ratelimit/config'
import {
  checkRateLimit,
  getClientIp,
  RATE_LIMIT_ERROR_FALLBACK,
  RATE_LIMIT_FALLBACK_KEY,
} from '@open-mercato/shared/lib/ratelimit/helpers'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'

const logger = createLogger('public_booking').child({ component: 'rate-limit' })

export const publicBookingReadRateLimitConfig = readEndpointRateLimitConfig('PUBLIC_BOOKING_READ', {
  points: 120,
  duration: 60,
  blockDuration: 60,
  keyPrefix: 'public-booking-read',
})

type RateLimiterContainer = {
  resolve(name: string): unknown
  hasRegistration?(name: string): boolean
}

/** Read endpoints fail open: an unavailable limiter cannot take the public site offline. */
export async function enforcePublicBookingReadRateLimit(
  request: Request,
  container: RateLimiterContainer,
): Promise<Response | null> {
  let limiter: RateLimiterService | null = null
  try {
    if (container.hasRegistration?.('rateLimiterService') === false) return null
    limiter = (container.resolve('rateLimiterService') as RateLimiterService | undefined) ?? null
  } catch {
    logger.warn('Public booking read limiter is unavailable; allowing read')
    return null
  }
  if (!limiter) return null
  try {
    const client = getClientIp(request, limiter.trustProxyDepth) ?? RATE_LIMIT_FALLBACK_KEY
    return await checkRateLimit(
      limiter,
      publicBookingReadRateLimitConfig,
      `public-booking-read:${client}`,
      RATE_LIMIT_ERROR_FALLBACK,
    )
  } catch (error) {
    logger.warn('Public booking read limiter failed; allowing read', { err: error })
    return null
  }
}
