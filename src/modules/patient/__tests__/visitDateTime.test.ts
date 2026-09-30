import { describe, expect, it } from '@jest/globals'
import {
  instantOffsetInTimeZone,
  resolveVisitInstant,
  toVisitLocalDateTime,
  visitInstantChoices,
} from '../lib/visitDateTime'

describe('visit local date-time conversion', () => {
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
})
