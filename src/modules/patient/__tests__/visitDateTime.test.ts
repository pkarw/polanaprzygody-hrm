import { describe, expect, it } from '@jest/globals'
import {
  buildVisitSchedule,
  instantOffsetInTimeZone,
  resolveVisitInstant,
  toVisitLocalDateTime,
  visitCalendarDayRange,
  visitInstantChoices,
} from '../lib/visitDateTime'

describe('visit local date-time conversion', () => {
  it('builds DST-safe local day ranges for calendar deep links', () => {
    expect(visitCalendarDayRange('2026-03-29T10:00:00+02:00', 'Europe/Warsaw')).toEqual({
      from: '2026-03-28T23:00:00.000Z',
      to: '2026-03-29T22:00:00.000Z',
    })
    expect(visitCalendarDayRange('2026-10-25T10:00:00+01:00', 'Europe/Warsaw')).toEqual({
      from: '2026-10-24T22:00:00.000Z',
      to: '2026-10-25T23:00:00.000Z',
    })
    expect(visitCalendarDayRange('invalid', 'Europe/Warsaw')).toBeNull()
  })

  it('resolves an ordinary Warsaw time to its explicit offset', () => {
    expect(visitInstantChoices('2026-10-05T10:00', 'Europe/Warsaw')).toEqual([
      { instant: '2026-10-05T10:00:00+02:00', offset: '+02:00' },
    ])
  })

  it('rejects a spring DST gap', () => {
    expect(visitInstantChoices('2026-03-29T02:30', 'Europe/Warsaw')).toEqual([])
    expect(resolveVisitInstant('2026-03-29T02:30', 'Europe/Warsaw')).toBeNull()
  })

  it('requires an explicit offset for the autumn fold', () => {
    expect(visitInstantChoices('2026-10-25T02:30', 'Europe/Warsaw')).toEqual([
      { instant: '2026-10-25T02:30:00+02:00', offset: '+02:00' },
      { instant: '2026-10-25T02:30:00+01:00', offset: '+01:00' },
    ])
    expect(resolveVisitInstant('2026-10-25T02:30', 'Europe/Warsaw')).toBeNull()
    expect(resolveVisitInstant('2026-10-25T02:30', 'Europe/Warsaw', '+01:00')?.instant)
      .toBe('2026-10-25T02:30:00+01:00')
  })

  it('round-trips an instant in a zone other than the browser zone', () => {
    const instant = '2026-12-01T15:45:00+09:00'
    expect(toVisitLocalDateTime(instant, 'Asia/Tokyo')).toBe('2026-12-01T15:45')
    expect(instantOffsetInTimeZone(instant, 'Asia/Tokyo')).toBe('+09:00')
  })

  it('builds a schedule once for both the availability probe and mutation payload', () => {
    expect(buildVisitSchedule({
      startsAtLocal: '2026-10-05T10:00',
      endsAtLocal: '2026-10-05T11:00',
      timeZone: 'Europe/Warsaw',
    }, {
      gap: 'gap',
      fold: 'fold',
      offset: 'offset',
      endAfterStart: 'end',
    })).toEqual({
      startsAt: '2026-10-05T10:00:00+02:00',
      endsAt: '2026-10-05T11:00:00+02:00',
    })
  })

  it('rejects a schedule whose end is not after its start', () => {
    expect(() => buildVisitSchedule({
      startsAtLocal: '2026-10-05T10:00',
      endsAtLocal: '2026-10-05T10:00',
      timeZone: 'UTC',
    }, {
      gap: 'gap',
      fold: 'fold',
      offset: 'offset',
      endAfterStart: 'end',
    })).toThrow('end')
  })
})
