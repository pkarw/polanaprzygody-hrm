import { addDays } from 'date-fns/addDays'
import { startOfDay } from 'date-fns/startOfDay'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

export const PUBLIC_BOOKING_TIME_ZONE = 'Europe/Warsaw'
export const PUBLIC_BOOKING_MAX_DAYS = 60

/**
 * Returns the exact facility-calendar range rendered by the public booking UI.
 * `to` is exclusive: the range contains the next 60 Warsaw calendar days,
 * starting tomorrow, even when a DST boundary makes a day 23 or 25 hours long.
 */
export function publicBookingDateWindow(now: Date = new Date()): {
  from: Date
  to: Date
  days: Date[]
} {
  const localTomorrow = addDays(startOfDay(toZonedTime(now, PUBLIC_BOOKING_TIME_ZONE)), 1)
  return {
    from: fromZonedTime(localTomorrow, PUBLIC_BOOKING_TIME_ZONE),
    to: fromZonedTime(addDays(localTomorrow, PUBLIC_BOOKING_MAX_DAYS), PUBLIC_BOOKING_TIME_ZONE),
    days: Array.from({ length: PUBLIC_BOOKING_MAX_DAYS }, (_, index) => (
      fromZonedTime(addDays(localTomorrow, index), PUBLIC_BOOKING_TIME_ZONE)
    )),
  }
}
