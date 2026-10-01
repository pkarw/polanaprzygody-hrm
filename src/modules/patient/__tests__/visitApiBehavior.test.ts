import { describe, expect, it, jest } from '@jest/globals'
import { enrichPatientNextVisits, isVisitDetailQuery } from '../lib/visitApi'

jest.mock('@open-mercato/shared/lib/encryption/subscriber', () => ({
  decryptEntitiesWithFallbackScope: jest.fn(async () => undefined),
}))

const tenantId = '11111111-aaaa-4bbb-8ccc-dddddddddddd'
const organizationId = '22222222-aaaa-4bbb-8ccc-dddddddddddd'
const userId = '33333333-aaaa-4bbb-8ccc-dddddddddddd'
const patientA = '44444444-aaaa-4bbb-8ccc-dddddddddddd'
const patientB = '55555555-aaaa-4bbb-8ccc-dddddddddddd'

function makeContext({
  granted,
  visits = [],
  rbacError = false,
}: {
  granted: boolean
  visits?: Record<string, unknown>[]
  rbacError?: boolean
}) {
  const getResultList = jest.fn(async () => visits)
  const query = {
    select: jest.fn(),
    distinctOn: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    getResultList,
  }
  query.select.mockReturnValue(query as never)
  query.distinctOn.mockReturnValue(query as never)
  query.where.mockReturnValue(query as never)
  query.orderBy.mockReturnValue(query as never)
  const createQueryBuilder = jest.fn(() => query)
  const userHasAllFeatures = jest.fn(async (
    _userId: string,
    _required: string[],
    _scope: { tenantId: string | null; organizationId: string | null },
  ) => granted)
  const resolve = jest.fn((name: string) => {
    if (name === 'rbacService') {
      if (rbacError) throw new Error('RBAC unavailable')
      return { userHasAllFeatures }
    }
    if (name === 'em') return { createQueryBuilder }
    throw new Error(`Unexpected dependency: ${name}`)
  })
  return {
    ctx: {
      auth: { sub: userId, tenantId, orgId: organizationId },
      selectedOrganizationId: organizationId,
      container: { resolve },
    } as never,
    query,
    createQueryBuilder,
    userHasAllFeatures,
  }
}

describe('visit API executable behavior', () => {
  it('projects description only for explicit id details, never ids lists', () => {
    expect(isVisitDetailQuery({ id: patientA })).toBe(true)
    expect(isVisitDetailQuery({ ids: patientA })).toBe(false)
    expect(isVisitDetailQuery({ ids: `${patientA},${patientB}` })).toBe(false)
  })

  it('fails closed and removes a cached nextVisit when the grant is absent', async () => {
    const fixture = makeContext({ granted: false })
    const items = [{
      id: patientA,
      nextVisit: {
        startsAt: '2026-10-02T08:00:00.000Z',
        timeZone: 'Europe/Warsaw',
        resourceNameSnapshot: 'Gabinet 1',
        confirmedAt: null,
      },
    }]

    await enrichPatientNextVisits(items, fixture.ctx)

    expect(items[0]).not.toHaveProperty('nextVisit')
    expect(fixture.userHasAllFeatures).toHaveBeenCalledWith(
      userId,
      ['patient.visits.view'],
      { tenantId, organizationId },
    )
    expect(fixture.createQueryBuilder).not.toHaveBeenCalled()
  })

  it.each(['missing scope', 'RBAC failure'])('removes cached data on %s', async (failure) => {
    const fixture = makeContext({ granted: true, rbacError: failure === 'RBAC failure' })
    if (failure === 'missing scope') {
      ;(fixture.ctx as { selectedOrganizationId: string | null }).selectedOrganizationId = null
      ;(fixture.ctx as { auth: { orgId: string | null } }).auth.orgId = null
    }
    const items = [{
      id: patientA,
      nextVisit: {
        startsAt: '2026-10-02T08:00:00.000Z',
        timeZone: 'Europe/Warsaw',
        resourceNameSnapshot: null,
        confirmedAt: null,
      },
    }]

    await enrichPatientNextVisits(items, fixture.ctx)

    expect(items[0]).not.toHaveProperty('nextVisit')
    expect(fixture.createQueryBuilder).not.toHaveBeenCalled()
  })

  it('uses one scoped DISTINCT ON query and returns the nearest visit or explicit null', async () => {
    const first = {
      id: '66666666-aaaa-4bbb-8ccc-dddddddddddd',
      patientId: patientA,
      startsAt: new Date('2026-10-02T08:00:00.000Z'),
      timeZone: 'Europe/Warsaw',
      resourceNameSnapshot: 'Gabinet 1',
      confirmedAt: new Date('2026-10-01T08:00:00.000Z'),
    }
    const laterSamePatient = {
      ...first,
      id: '77777777-aaaa-4bbb-8ccc-dddddddddddd',
      startsAt: new Date('2026-10-03T08:00:00.000Z'),
    }
    const fixture = makeContext({ granted: true, visits: [first, laterSamePatient] })
    const items = [{ id: patientA }, { id: patientB }]
    const now = new Date('2026-10-01T00:00:00.000Z')

    await enrichPatientNextVisits(items, fixture.ctx, now)

    expect(fixture.createQueryBuilder).toHaveBeenCalledTimes(1)
    expect(fixture.query.distinctOn).toHaveBeenCalledWith('visit.patientId')
    expect(fixture.query.where).toHaveBeenCalledWith({
      patientId: { $in: [patientA, patientB] },
      tenantId,
      organizationId,
      status: 'planned',
      startsAt: { $gte: now },
      deletedAt: null,
    })
    expect(items).toEqual([
      {
        id: patientA,
        nextVisit: {
          startsAt: '2026-10-02T08:00:00.000Z',
          timeZone: 'Europe/Warsaw',
          resourceNameSnapshot: 'Gabinet 1',
          confirmedAt: '2026-10-01T08:00:00.000Z',
        },
      },
      { id: patientB, nextVisit: null },
    ])
  })
})
