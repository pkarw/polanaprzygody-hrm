import { describe, expect, it, jest } from '@jest/globals'
import { createPatientAvailabilityService } from '../lib/patientAvailabilityService'

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }
const memberId = '11111111-1111-4111-8111-111111111111'
const resourceId = '22222222-2222-4222-8222-222222222222'
const ruleSetId = '33333333-3333-4333-8333-333333333333'
const range = {
  start: new Date('2026-09-28T00:00:00.000Z'),
  end: new Date('2026-10-05T00:00:00.000Z'),
}

function queryResult(items: Record<string, unknown>[]) {
  return { items, page: 1, pageSize: 100, total: items.length }
}

describe('patientAvailabilityService', () => {
  it('keeps CLASSIC injection parameter names stable', () => {
    const source = createPatientAvailabilityService.toString()
    const params = source.slice(source.indexOf('(') + 1, source.indexOf(')'))
      .split(',')
      .map((value) => value.replace(/:.*$/, '').trim())
    expect(params.slice(0, 2)).toEqual(['em', 'queryEngine'])
  })

  it('uses scoped QueryEngine reads and overlays a direct leave on ruleset availability', async () => {
    const query = jest.fn(async (entityId: string, _options: unknown) => entityId === 'resources:resources_resource'
      ? queryResult([{
          id: resourceId,
          is_active: true,
          deleted_at: null,
          availability_rule_set_id: ruleSetId,
        }])
      : queryResult([
          {
            id: 'base', subject_type: 'ruleset', subject_id: ruleSetId,
            rrule: 'DTSTART:20260928T080000Z\nDURATION:PT8H\nRRULE:FREQ=WEEKLY',
            exdates: [], kind: 'availability',
          },
          {
            id: 'leave', subject_type: 'resource', subject_id: resourceId,
            rrule: 'DTSTART:20260928T100000Z\nDURATION:PT1H\nRRULE:FREQ=WEEKLY',
            exdates: [], kind: 'unavailability',
            unavailability_reason_entry_id: '44444444-4444-4444-8444-444444444444',
            unavailability_reason_value: 'Approved absence',
          },
        ]))
    const merge = jest.fn(({ rules }: { rules: Array<Record<string, unknown>> }) => rules.map((rule, index) => ({
      start: new Date(range.start.getTime() + index * 3_600_000),
      end: new Date(range.start.getTime() + (index + 1) * 3_600_000),
      ruleId: String(rule.id),
    })))
    const service = createPatientAvailabilityService({ find: jest.fn() } as never, { query } as never)
    const [result] = await service.getSubjectAvailability({
      scope,
      range,
      resource: { id: resourceId, name: 'Gabinet 2', exposeReason: true },
      plannerAvailabilityService: { getMergedAvailabilityWindows: merge },
    })

    expect(query.mock.calls[0]).toEqual(['resources:resources_resource', expect.objectContaining({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      withDeleted: true,
    })])
    expect(query.mock.calls[1]).toEqual(['planner:planner_availability_rule', expect.objectContaining({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })])
    expect(result).toMatchObject({ hasSchedule: true, isActive: true })
    expect(result).not.toHaveProperty('unknown')
    expect(result?.unavailableWindows[0]).toMatchObject({
      reasonKind: 'leave', reasonLabel: 'Approved absence',
    })
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({
      rules: expect.arrayContaining([
        expect.objectContaining({ id: 'base', kind: 'availability' }),
        expect.objectContaining({ id: 'leave', kind: 'unavailability' }),
      ]),
    }))
  })

  it('prefers direct availability over ruleset availability', async () => {
    const query = jest.fn(async (entityId: string, _options: unknown) => entityId === 'resources:resources_resource'
      ? queryResult([{ id: resourceId, is_active: true, deleted_at: null, availability_rule_set_id: ruleSetId }])
      : queryResult([
          { id: 'base', subject_type: 'ruleset', subject_id: ruleSetId, rrule: 'base', exdates: [], kind: 'availability' },
          { id: 'direct', subject_type: 'resource', subject_id: resourceId, rrule: 'direct', exdates: [], kind: 'availability' },
        ]))
    const merge = jest.fn((_input: { rules: Array<Record<string, unknown>> }) => [])
    const service = createPatientAvailabilityService({ find: jest.fn() } as never, { query } as never)
    await service.getSubjectAvailability({
      scope, range, resource: { id: resourceId, name: 'Gabinet 2' },
      plannerAvailabilityService: { getMergedAvailabilityWindows: merge },
    })
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({
      rules: [expect.objectContaining({ id: 'direct' })],
    }))
  })

  it('degrades planner failures without hiding an inactive resource', async () => {
    const query = jest.fn(async (entityId: string, _options: unknown) => {
      if (entityId === 'resources:resources_resource') {
        return queryResult([{ id: resourceId, is_active: false, deleted_at: null, availability_rule_set_id: null }])
      }
      throw new Error('planner unavailable')
    })
    const service = createPatientAvailabilityService({ find: jest.fn() } as never, { query } as never)
    const [result] = await service.getSubjectAvailability({
      scope, range, resource: { id: resourceId, name: 'Gabinet 2' },
      plannerAvailabilityService: { getMergedAvailabilityWindows: () => [] },
    })
    expect(result).toMatchObject({ unknown: true, isActive: false })
  })

  it('degrades a member ruleset lookup failure instead of failing the calendar', async () => {
    const query = jest.fn(async (entityId: string, _options: unknown) => {
      if (entityId === 'staff:staff_team_member') throw new Error('staff availability read failed')
      return queryResult([])
    })
    const service = createPatientAvailabilityService({ find: jest.fn() } as never, { query } as never)
    const [result] = await service.getSubjectAvailability({
      scope,
      range,
      teamMember: { id: memberId, name: 'Anna Nowicka' },
      plannerAvailabilityService: { getMergedAvailabilityWindows: () => [] },
    })
    expect(result).toMatchObject({ subjectType: 'member', unknown: true, hasSchedule: false })
  })

  it('keeps the installed planner merger as the DST oracle', async () => {
    const query = jest.fn(async (_entityId: string, _options: unknown) => queryResult([{
      id: 'weekly', subject_type: 'member', subject_id: memberId,
      rrule: 'DTSTART:20261018T080000Z\nDURATION:PT1H\nRRULE:FREQ=WEEKLY;COUNT=4',
      exdates: [], kind: 'availability',
    }]))
    const installedWindow = {
      start: new Date('2026-10-25T08:00:00.000Z'),
      end: new Date('2026-10-25T09:00:00.000Z'),
    }
    const merge = jest.fn(() => [installedWindow])
    const service = createPatientAvailabilityService({ find: jest.fn() } as never, { query } as never)
    const [result] = await service.getSubjectAvailability({
      scope,
      range: { start: new Date('2026-10-24T00:00:00Z'), end: new Date('2026-10-26T00:00:00Z') },
      teamMember: { id: memberId, name: 'Anna Nowicka' },
      plannerAvailabilityService: { getMergedAvailabilityWindows: merge },
    })
    expect(result?.availableWindows).toEqual([installedWindow])
  })

  it('uses the point-visit predicate that catches identical points and containing intervals', async () => {
    const find = jest.fn(async (_entity: unknown, _where: unknown, _options: unknown) => [])
    const query = jest.fn(async (_entityId: string, _options: unknown) => queryResult([]))
    const service = createPatientAvailabilityService({ find } as never, { query } as never)
    const point = new Date('2026-09-30T10:00:00.000Z')
    await service.findOverlappingVisits({
      scope,
      draft: {
        teamMemberId: memberId,
        teamMemberName: 'Anna Nowicka',
        startsAt: point,
        endsAt: null,
      },
    })
    const where = find.mock.calls[0]?.[1] as Record<string, unknown>
    expect(where).toMatchObject({ tenantId: scope.tenantId, organizationId: scope.organizationId })
    expect(JSON.stringify(where)).toContain('$lte')
    expect(JSON.stringify(where)).toContain('$gt')
    expect(JSON.stringify(where)).toContain(point.toISOString())
  })
})
