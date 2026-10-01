import { describe, expect, it, jest } from '@jest/globals'
import {
  findPublicBookingAvailability,
  listPublicBookingServices,
  listPublicBookingTherapists,
  resolvePublicBookingSlot,
} from '../lib/publicDiscovery'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}
const productId = '33333333-3333-4333-8333-333333333333'
const therapistId = '44444444-4444-4444-8444-444444444444'
const inactiveTherapistId = '55555555-5555-4555-8555-555555555555'
const roomId = '66666666-6666-4666-8666-666666666666'

function queryEngine(options: { incomplete?: boolean; includeInactive?: boolean } = {}) {
  return {
    query: jest.fn(async (entityId: string) => {
      if (entityId === 'catalog:catalog_product') {
        return {
          total: options.incomplete ? 2 : 1,
          items: [
            {
              id: productId,
              title: 'Diagnoza logopedyczna',
              description: 'Opis',
              'cf:booking_duration_minutes': 60,
              'cf:booking_team_member_ids': [therapistId, inactiveTherapistId],
              'cf:booking_resource_ids': [roomId],
            },
            ...(options.incomplete ? [{
              id: '77777777-7777-4777-8777-777777777777',
              title: 'Incomplete',
              'cf:booking_duration_minutes': 60,
              'cf:booking_team_member_ids': [],
              'cf:booking_resource_ids': [roomId],
            }] : []),
          ],
        }
      }
      if (entityId === 'staff:staff_team_member') {
        return {
          total: 1,
          items: [{
            id: therapistId,
            display_name: 'Anna Nowicka',
            'cf:polana_photo_url': 'https://example.test/anna.jpg',
            'cf:polana_short_bio': 'Neurologopedka',
            'cf:polana_specializations': ['Logopedia'],
          }],
        }
      }
      if (entityId === 'resources:resources_resource') {
        return { total: 1, items: [{ id: roomId, name: 'Gabinet logopedy' }] }
      }
      throw new Error(`unexpected entity ${entityId}`)
    }),
  }
}

function windowSubject(subjectType: 'member' | 'resource', subjectId: string) {
  return {
    subjectType,
    subjectId,
    subjectName: 'Subject',
    hasSchedule: true,
    isActive: true,
    availableWindows: [{
      start: new Date('2026-10-02T08:00:00.000Z'),
      end: new Date('2026-10-02T12:00:00.000Z'),
    }],
    unavailableWindows: [],
  }
}

describe('public booking discovery', () => {
  it('lists only complete services with promotion and regular-price evidence', async () => {
    const promotion = {
      product: productId,
      currencyCode: 'PLN',
      unitPriceGross: '249.0000',
      kind: 'promotion',
      priceKind: { code: 'promotion', isPromotion: true },
    }
    const regular = {
      product: productId,
      currencyCode: 'PLN',
      unitPriceGross: '300.0000',
      kind: 'regular',
      priceKind: { code: 'regular', isPromotion: false },
    }
    const pricing = {
      resolvePriceMany: jest.fn(async (entries: Array<{ rows: typeof promotion[] }>) => (
        entries.map((entry) => entry.rows.find((row) => row.kind === 'promotion') ?? entry.rows[0] ?? null)
      )),
    }
    const em = {
      find: jest.fn(async (entity: { name: string }) => (
        entity.name === 'CatalogProductCategoryAssignment'
          ? [{ product: { id: productId }, category: { name: 'Diagnoza' } }]
          : [promotion, regular]
      )),
    }
    const services = await listPublicBookingServices({
      em: em as never,
      container: { resolve: () => pricing } as never,
      queryEngine: queryEngine({ incomplete: true }) as never,
      scope,
      now: new Date('2026-10-01T08:00:00.000Z'),
    })

    expect(services).toEqual([expect.objectContaining({
      id: productId,
      durationMinutes: 60,
      category: 'Diagnoza',
      price: {
        currency: 'PLN',
        amount: '249.0000',
        wasAmount: '300.0000',
        isPromotion: true,
      },
    })])
  })

  it('returns only active assigned therapists with public profile fields', async () => {
    const therapists = await listPublicBookingTherapists({
      queryEngine: queryEngine() as never,
      scope,
      productId,
    })

    expect(therapists).toEqual([{
      id: therapistId,
      displayName: 'Anna Nowicka',
      photoUrl: 'https://example.test/anna.jpg',
      shortBio: 'Neurologopedka',
      specializations: ['Logopedia'],
    }])
  })

  it('returns only slots free for therapist and at least one room without exposing room ids', async () => {
    const availability = {
      getSubjectAvailability: jest.fn(async (input: { teamMember?: { id: string }; resource?: { id: string } }) => (
        input.teamMember
          ? [windowSubject('member', input.teamMember.id)]
          : [windowSubject('resource', input.resource!.id)]
      )),
    }
    const em = {
      find: jest.fn(async () => [{
        teamMemberId: therapistId,
        resourceId: null,
        startsAt: new Date('2026-10-02T09:00:00.000Z'),
        endsAt: new Date('2026-10-02T10:00:00.000Z'),
      }]),
    }
    const container = {
      resolve: (name: string) => name === 'patientAvailabilityService' ? availability : {},
    }
    const result = await findPublicBookingAvailability({
      em: em as never,
      container: container as never,
      queryEngine: queryEngine() as never,
      scope,
      productId,
      teamMemberId: therapistId,
      from: new Date('2026-10-02T08:00:00.000Z'),
      to: new Date('2026-10-02T12:00:00.000Z'),
      now: new Date('2026-10-01T08:00:00.000Z'),
    })

    expect(result.slots).toHaveLength(6)
    expect(result.slots[0]).toMatchObject({
      startsAt: '2026-10-02T10:00:00.000+02:00',
      endsAt: '2026-10-02T11:00:00.000+02:00',
      timeZone: 'Europe/Warsaw',
    })
    expect(result.slots.some((slot) => Date.parse(slot.startsAt) === Date.parse('2026-10-02T09:00:00.000Z'))).toBe(false)
    expect(JSON.stringify(result)).not.toContain(roomId)
  })

  it('fails closed with degraded=true when planner support is missing', async () => {
    const container = {
      resolve: (name: string) => {
        if (name === 'patientAvailabilityService') return { getSubjectAvailability: jest.fn() }
        throw new Error('planner not installed')
      },
    }
    const result = await findPublicBookingAvailability({
      em: { find: jest.fn() } as never,
      container: container as never,
      queryEngine: queryEngine() as never,
      scope,
      productId,
      teamMemberId: therapistId,
      from: new Date('2026-10-02T08:00:00.000Z'),
      to: new Date('2026-10-02T12:00:00.000Z'),
      now: new Date('2026-10-01T08:00:00.000Z'),
    })

    expect(result).toEqual({ slots: [], degraded: true })
  })

  it('revalidates an exact slot and selects the first configured free room server-side', async () => {
    const availability = {
      getSubjectAvailability: jest.fn(async (input: { teamMember?: { id: string }; resource?: { id: string } }) => (
        input.teamMember
          ? [windowSubject('member', input.teamMember.id)]
          : [windowSubject('resource', input.resource!.id)]
      )),
    }
    const result = await resolvePublicBookingSlot({
      em: { find: jest.fn(async () => []) } as never,
      container: {
        resolve: (name: string) => name === 'patientAvailabilityService' ? availability : {},
      } as never,
      queryEngine: queryEngine() as never,
      scope,
      productId,
      teamMemberId: therapistId,
      startsAt: new Date('2026-10-02T08:00:00.000Z'),
      endsAt: new Date('2026-10-02T09:00:00.000Z'),
      timeZone: 'Europe/Warsaw',
      now: new Date('2026-10-01T08:00:00.000Z'),
    })

    expect(result).toEqual({
      resourceId: roomId,
      startsAt: new Date('2026-10-02T08:00:00.000Z'),
      endsAt: new Date('2026-10-02T09:00:00.000Z'),
    })
  })

  it('maps an exact persisted overlap to a generic slot conflict', async () => {
    const availability = {
      getSubjectAvailability: jest.fn(async (input: { teamMember?: { id: string }; resource?: { id: string } }) => (
        input.teamMember
          ? [windowSubject('member', input.teamMember.id)]
          : [windowSubject('resource', input.resource!.id)]
      )),
    }
    await expect(resolvePublicBookingSlot({
      em: { find: jest.fn(async () => [{
        teamMemberId: therapistId,
        resourceId: roomId,
        startsAt: new Date('2026-10-02T08:00:00.000Z'),
        endsAt: new Date('2026-10-02T09:00:00.000Z'),
      }]) } as never,
      container: {
        resolve: (name: string) => name === 'patientAvailabilityService' ? availability : {},
      } as never,
      queryEngine: queryEngine() as never,
      scope,
      productId,
      teamMemberId: therapistId,
      startsAt: new Date('2026-10-02T08:00:00.000Z'),
      endsAt: new Date('2026-10-02T09:00:00.000Z'),
      timeZone: 'Europe/Warsaw',
      now: new Date('2026-10-01T08:00:00.000Z'),
    })).rejects.toMatchObject({ status: 409 })
  })

  it('refuses an exact booking write when planner support is unavailable', async () => {
    await expect(resolvePublicBookingSlot({
      em: { find: jest.fn(async () => []) } as never,
      container: {
        resolve: (name: string) => {
          if (name === 'patientAvailabilityService') return { getSubjectAvailability: jest.fn() }
          throw new Error('planner unavailable')
        },
      } as never,
      queryEngine: queryEngine() as never,
      scope,
      productId,
      teamMemberId: therapistId,
      startsAt: new Date('2026-10-02T08:00:00.000Z'),
      endsAt: new Date('2026-10-02T09:00:00.000Z'),
      timeZone: 'Europe/Warsaw',
      now: new Date('2026-10-01T08:00:00.000Z'),
    })).rejects.toMatchObject({ status: 503 })
  })
})
