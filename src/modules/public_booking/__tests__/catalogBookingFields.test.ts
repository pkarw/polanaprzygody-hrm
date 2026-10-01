import { describe, expect, it } from '@jest/globals'
import {
  PUBLIC_BOOKING_PRODUCT_FIELDS,
  PUBLIC_BOOKING_PRODUCT_FIELD_KEYS,
} from '../lib/catalogBookingFields'

describe('public booking catalog fields', () => {
  it('declares the bounded duration and exact scoped relation option sources', () => {
    expect([...PUBLIC_BOOKING_PRODUCT_FIELD_KEYS]).toEqual([
      'booking_duration_minutes',
      'booking_team_member_ids',
      'booking_resource_ids',
    ])
    const duration = PUBLIC_BOOKING_PRODUCT_FIELDS[0]
    expect(duration).toEqual(expect.objectContaining({
      kind: 'integer',
      formEditable: true,
      validation: [{ rule: 'min', param: 1 }, { rule: 'max', param: 480 }],
    }))
    expect(PUBLIC_BOOKING_PRODUCT_FIELDS[1]).toEqual(expect.objectContaining({
      kind: 'relation',
      multi: true,
      relatedEntityId: 'staff:staff_team_member',
      optionsUrl: '/api/entities/relations/options?entityId=staff%3Astaff_team_member',
    }))
    expect(PUBLIC_BOOKING_PRODUCT_FIELDS[2]).toEqual(expect.objectContaining({
      kind: 'relation',
      multi: true,
      relatedEntityId: 'resources:resources_resource',
      optionsUrl: '/api/entities/relations/options?entityId=resources%3Aresources_resource',
    }))
  })
})
