import { addDays } from 'date-fns/addDays'
import { startOfDay } from 'date-fns/startOfDay'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

export type VisitInstantChoice = { instant: string; offset: string }

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

function offsetText(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-'
  const absolute = Math.abs(minutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

function wallClockAt(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}T${byType.get('hour')}:${byType.get('minute')}:${byType.get('second')}`
}

/** Returns zero (DST gap), one (normal), or two (DST fold) matching explicit offsets. */
export function visitInstantChoices(localDateTime: string, timeZone: string): VisitInstantChoice[] {
  const match = LOCAL_PATTERN.exec(localDateTime)
  if (!match || !timeZone) return []
  const normalizedLocal = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}`
  const choices: VisitInstantChoice[] = []
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format()
    for (let minutes = -14 * 60; minutes <= 14 * 60; minutes += 15) {
      const offset = offsetText(minutes)
      const candidate = new Date(`${normalizedLocal}${offset}`)
      if (!Number.isNaN(candidate.getTime()) && wallClockAt(candidate, timeZone) === normalizedLocal) {
        choices.push({ instant: `${normalizedLocal}${offset}`, offset })
      }
    }
  } catch {
    return []
  }
  return choices.sort((left, right) => Date.parse(left.instant) - Date.parse(right.instant))
}

export function resolveVisitInstant(
  localDateTime: string,
  timeZone: string,
  preferredOffset?: string | null,
): VisitInstantChoice | null {
  const choices = visitInstantChoices(localDateTime, timeZone)
  if (choices.length === 1) return choices[0]
  if (preferredOffset) return choices.find((choice) => choice.offset === preferredOffset) ?? null
  return null
}

export function toVisitLocalDateTime(instant: string, timeZone: string): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return ''
  return wallClockAt(date, timeZone).slice(0, 16)
}

export function instantOffsetInTimeZone(instant: string, timeZone: string): string | null {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return null
  const local = wallClockAt(date, timeZone)
  return visitInstantChoices(local.slice(0, 16), timeZone)
    .find((choice) => Date.parse(choice.instant) === date.getTime())?.offset ?? null
}

export function defaultVisitTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function visitCalendarDayRange(
  instant: string,
  timeZone: string,
): { from: string; to: string } | null {
  const value = new Date(instant)
  if (!Number.isFinite(value.getTime())) return null
  try {
    const localStart = startOfDay(toZonedTime(value, timeZone))
    return {
      from: fromZonedTime(localStart, timeZone).toISOString(),
      to: fromZonedTime(addDays(localStart, 1), timeZone).toISOString(),
    }
  } catch {
    return null
  }
}

export type VisitScheduleFormValue = {
  startsAtLocal: string
  endsAtLocal?: string | null
  timeZone: string
}

/**
 * On the autumn DST fold a local time matches two instants; the operator has no way to pick
 * one (no UTC-offset field), so this takes the chronologically earlier one.
 */
export function buildVisitSchedule(
  value: VisitScheduleFormValue,
  labels: { gap: string; endAfterStart: string },
): { startsAt: string; endsAt: string | null } {
  const resolve = (local: string) => {
    const choices = visitInstantChoices(local, value.timeZone)
    if (choices.length === 0) throw new Error(labels.gap)
    return choices[0].instant
  }
  const startsAt = resolve(value.startsAtLocal)
  const endsAt = value.endsAtLocal ? resolve(value.endsAtLocal) : null
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new Error(labels.endAfterStart)
  }
  return { startsAt, endsAt }
}
