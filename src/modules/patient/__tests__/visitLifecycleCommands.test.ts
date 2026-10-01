import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'
import { commandRegistry, type CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Patient, PatientVisit } from '../data/entities'
import { emitPatientEvent } from '../events'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))

jest.mock('../events', () => ({
  emitPatientEvent: jest.fn(async () => undefined),
}))

const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  organization: '22222222-2222-4222-8222-222222222222',
  actor: '33333333-3333-4333-8333-333333333333',
  patient: '44444444-4444-4444-8444-444444444444',
  visit: '55555555-5555-4555-8555-555555555555',
  teamMember: '66666666-6666-4666-8666-666666666666',
}

type Harness = {
  context: CommandRuntimeContext
  patient: Patient
  visit: PatientVisit
  commit: jest.MockedFunction<() => Promise<void>>
  rollback: jest.MockedFunction<() => Promise<void>>
  markOrmEntityChange: jest.Mock
  userHasAllFeatures: jest.MockedFunction<(
    userId: string,
    features: string[],
    scope: { tenantId: string; organizationId: string },
  ) => Promise<boolean>>
}

function createHarness(
  overrides: Partial<PatientVisit> = {},
  grantedFeatures: string[] | null = null,
): Harness {
  const initialUpdatedAt = new Date('2026-09-30T09:00:00.000Z')
  const patient = {
    id: ids.patient,
    tenantId: ids.tenant,
    organizationId: ids.organization,
    status: 'active',
    updatedAt: new Date(initialUpdatedAt),
    updatedByUserId: ids.actor,
    deletedAt: null,
  } as Patient
  const visit = {
    id: ids.visit,
    tenantId: ids.tenant,
    organizationId: ids.organization,
    patientId: ids.patient,
    teamMemberId: ids.teamMember,
    teamMemberNameSnapshot: 'Encrypted team member',
    resourceId: null,
    resourceNameSnapshot: null,
    startsAt: new Date('2026-09-30T08:00:00.000Z'),
    endsAt: null,
    timeZone: 'UTC',
    description: null,
    status: 'planned',
    confirmedAt: null,
    confirmedByUserId: null,
    statusChangedAt: new Date(initialUpdatedAt),
    statusChangedByUserId: ids.actor,
    statusReason: null,
    isSettled: false,
    settledAt: null,
    settledByUserId: null,
    settlementReason: null,
    clientRequestId: '77777777-7777-4777-8777-777777777777',
    createRequestPayload: 'encrypted-request',
    createdAt: new Date(initialUpdatedAt),
    updatedAt: new Date(initialUpdatedAt),
    createdByUserId: ids.actor,
    updatedByUserId: ids.actor,
    deletedAt: null,
    ...overrides,
  } as PatientVisit

  const begin = jest.fn(async () => undefined)
  const commit = jest.fn(async () => undefined)
  const rollback = jest.fn(async () => undefined)
  const flush = jest.fn(async () => undefined)
  const persist = jest.fn((entity: unknown) => entity)
  const execute = jest.fn(async () => undefined)
  const findOne = jest.fn(async (entity: unknown) => entity === Patient ? patient : visit)
  const em = {
    begin,
    commit,
    rollback,
    flush,
    persist,
    execute,
    findOne,
    fork: () => em,
    isInTransaction: () => false,
  } as unknown as EntityManager
  const userHasAllFeatures = jest.fn(async (
    _userId: string,
    features: string[],
  ) => grantedFeatures === null || features.every((feature) => grantedFeatures.includes(feature)))
  const encryptEntityPayload = jest.fn(async (
    _entityId: string,
    payload: Record<string, unknown>,
  ) => Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, `enc:${String(value)}`])))
  const markOrmEntityChange = jest.fn()
  const resolve = (token: string) => {
    if (token === 'em') return em
    if (token === 'rbacService') return { userHasAllFeatures }
    if (token === 'tenantEncryptionService') return { encryptEntityPayload }
    if (token === 'dataEngine') return { markOrmEntityChange }
    throw new Error(`[internal] Unexpected dependency ${token}`)
  }
  const context: CommandRuntimeContext = {
    container: { resolve } as unknown as CommandRuntimeContext['container'],
    auth: { sub: ids.actor, tenantId: ids.tenant, orgId: ids.organization },
    selectedOrganizationId: ids.organization,
    organizationScope: null,
    organizationIds: [ids.organization],
  }
  jest.mocked(findOneWithDecryption).mockResolvedValue(visit as never)
  return { context, patient, visit, commit, rollback, markOrmEntityChange, userHasAllFeatures }
}

async function execute(
  commandId: string,
  input: Record<string, unknown>,
  context: CommandRuntimeContext,
): Promise<unknown> {
  const handler = commandRegistry.get<Record<string, unknown>, unknown>(commandId)
  if (!handler) throw new Error(`[internal] Missing command ${commandId}`)
  return await handler.execute(input, context)
}

describe('patient visit lifecycle command behavior', () => {
  beforeAll(async () => {
    if (!commandRegistry.get('patient.visits.confirm')) await import('../commands/visits')
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('confirms and unconfirms only a planned visit with server actor/time and one event each', async () => {
    const harness = createHarness()
    const originalVersion = harness.visit.updatedAt.toISOString()

    await execute('patient.visits.confirm', {
      id: ids.visit,
      expectedUpdatedAt: originalVersion,
    }, harness.context)
    expect(harness.visit.confirmedAt).toBeInstanceOf(Date)
    expect(harness.visit.confirmedByUserId).toBe(ids.actor)
    expect(harness.visit.updatedByUserId).toBe(ids.actor)
    expect(harness.visit.updatedAt.getTime()).toBeGreaterThan(Date.parse(originalVersion))
    expect(emitPatientEvent).toHaveBeenCalledTimes(1)
    expect(emitPatientEvent).toHaveBeenLastCalledWith('patient.visit.confirmed', expect.objectContaining({
      id: ids.visit,
      patientId: ids.patient,
      tenantId: ids.tenant,
      organizationId: ids.organization,
    }))

    const confirmedVersion = harness.visit.updatedAt.toISOString()
    await execute('patient.visits.unconfirm', {
      id: ids.visit,
      expectedUpdatedAt: confirmedVersion,
    }, harness.context)
    expect(harness.visit.confirmedAt).toBeNull()
    expect(harness.visit.confirmedByUserId).toBeNull()
    expect(emitPatientEvent).toHaveBeenCalledTimes(2)
    expect(emitPatientEvent).toHaveBeenLastCalledWith(
      'patient.visit.unconfirmed',
      expect.objectContaining({ id: ids.visit }),
    )

    await expect(execute('patient.visits.unconfirm', {
      id: ids.visit,
      expectedUpdatedAt: harness.visit.updatedAt.toISOString(),
    }, harness.context)).rejects.toMatchObject({
      status: 409,
      body: { code: 'visit_confirmation_unchanged' },
    })
    expect(emitPatientEvent).toHaveBeenCalledTimes(2)
  })

  it('closes and reopens while preserving settlement and clearing confirmation', async () => {
    const confirmedAt = new Date('2026-09-30T09:05:00.000Z')
    const settledAt = new Date('2026-09-30T09:06:00.000Z')
    const harness = createHarness({
      confirmedAt,
      confirmedByUserId: ids.actor,
      isSettled: true,
      settledAt,
      settledByUserId: ids.actor,
    })

    await execute('patient.visits.transition', {
      id: ids.visit,
      expectedUpdatedAt: harness.visit.updatedAt.toISOString(),
      status: 'completed',
    }, harness.context)
    expect(harness.visit.status).toBe('completed')
    expect(harness.visit.confirmedAt).toEqual(confirmedAt)
    expect(harness.visit.isSettled).toBe(true)
    expect(harness.visit.settledAt).toEqual(settledAt)
    expect(emitPatientEvent).toHaveBeenCalledTimes(1)
    expect(emitPatientEvent).toHaveBeenLastCalledWith(
      'patient.visit.status_changed',
      expect.objectContaining({ status: 'completed' }),
    )

    await execute('patient.visits.transition', {
      id: ids.visit,
      expectedUpdatedAt: harness.visit.updatedAt.toISOString(),
      status: 'planned',
      reason: 'Corrected after review',
    }, harness.context)
    expect(harness.visit.status).toBe('planned')
    expect(harness.visit.statusReason).toBe('enc:Corrected after review')
    expect(harness.visit.confirmedAt).toBeNull()
    expect(harness.visit.confirmedByUserId).toBeNull()
    expect(harness.visit.isSettled).toBe(true)
    expect(harness.visit.settledAt).toEqual(settledAt)
    expect(emitPatientEvent).toHaveBeenCalledTimes(3)
    expect(jest.mocked(emitPatientEvent).mock.calls.map(([eventId]) => eventId)).toEqual([
      'patient.visit.status_changed',
      'patient.visit.status_changed',
      'patient.visit.unconfirmed',
    ])
  })

  it('settles and unsets a closed visit without changing status or confirmation', async () => {
    const confirmedAt = new Date('2026-09-30T09:05:00.000Z')
    const harness = createHarness({
      status: 'cancelled',
      confirmedAt,
      confirmedByUserId: ids.actor,
    })

    await execute('patient.visits.settle', {
      id: ids.visit,
      expectedUpdatedAt: harness.visit.updatedAt.toISOString(),
      reason: 'Advance retained',
    }, harness.context)
    expect(harness.visit.status).toBe('cancelled')
    expect(harness.visit.confirmedAt).toEqual(confirmedAt)
    expect(harness.visit.isSettled).toBe(true)
    expect(harness.visit.settledAt).toBeInstanceOf(Date)
    expect(harness.visit.settledByUserId).toBe(ids.actor)
    expect(harness.visit.settlementReason).toBe('enc:Advance retained')

    await execute('patient.visits.unsettle', {
      id: ids.visit,
      expectedUpdatedAt: harness.visit.updatedAt.toISOString(),
      reason: 'Accounting correction',
    }, harness.context)
    expect(harness.visit.status).toBe('cancelled')
    expect(harness.visit.confirmedAt).toEqual(confirmedAt)
    expect(harness.visit.isSettled).toBe(false)
    expect(harness.visit.settledAt).toBeNull()
    expect(harness.visit.settledByUserId).toBeNull()
    expect(harness.visit.settlementReason).toBe('enc:Accounting correction')
    expect(jest.mocked(emitPatientEvent).mock.calls.map(([eventId]) => eventId)).toEqual([
      'patient.visit.settlement_changed',
      'patient.visit.settlement_changed',
    ])
  })

  it('rejects a stale cross-action version before mutation, audit side effects, or event emission', async () => {
    const harness = createHarness()
    const before = { ...harness.visit }

    await expect(execute('patient.visits.settle', {
      id: ids.visit,
      expectedUpdatedAt: '2026-09-30T08:59:59.000Z',
    }, harness.context)).rejects.toMatchObject({ status: 409, body: { code: 'version_conflict' } })
    expect(harness.visit).toMatchObject(before)
    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.rollback).toHaveBeenCalledTimes(1)
    expect(harness.markOrmEntityChange).not.toHaveBeenCalled()
    expect(emitPatientEvent).not.toHaveBeenCalled()
  })

  it('requires visits.correct to reopen and visits.settle for settlement without side effects', async () => {
    const reopenHarness = createHarness(
      { status: 'completed' },
      ['patient.visits.manage'],
    )
    await expect(execute('patient.visits.transition', {
      id: ids.visit,
      expectedUpdatedAt: reopenHarness.visit.updatedAt.toISOString(),
      status: 'planned',
      reason: 'Correction denied',
    }, reopenHarness.context)).rejects.toMatchObject({ status: 403 })
    expect(reopenHarness.visit.status).toBe('completed')
    expect(reopenHarness.userHasAllFeatures).toHaveBeenCalledWith(
      ids.actor,
      ['patient.visits.manage', 'patient.visits.correct'],
      { tenantId: ids.tenant, organizationId: ids.organization },
    )

    const settlementHarness = createHarness({}, ['patient.visits.manage'])
    await expect(execute('patient.visits.settle', {
      id: ids.visit,
      expectedUpdatedAt: settlementHarness.visit.updatedAt.toISOString(),
    }, settlementHarness.context)).rejects.toMatchObject({ status: 403 })
    expect(settlementHarness.visit.isSettled).toBe(false)
    expect(settlementHarness.userHasAllFeatures).toHaveBeenCalledWith(
      ids.actor,
      ['patient.visits.settle'],
      { tenantId: ids.tenant, organizationId: ids.organization },
    )
    expect(emitPatientEvent).not.toHaveBeenCalled()
  })

  it('refuses to reopen a visit after the locked patient has been archived', async () => {
    const harness = createHarness({
      status: 'completed',
      startsAt: new Date('2020-01-20T09:00:00.000Z'),
    })
    harness.patient.status = 'archived'

    await expect(execute('patient.visits.transition', {
      id: ids.visit,
      expectedUpdatedAt: harness.visit.updatedAt.toISOString(),
      status: 'planned',
      reason: 'Correction',
    }, harness.context)).rejects.toMatchObject({ status: 409 })

    expect(harness.visit.status).toBe('completed')
    expect(harness.rollback).toHaveBeenCalled()
  })

  it('never duplicates encrypted reason text into lifecycle audit snapshots', async () => {
    const harness = createHarness({
      statusReason: 'decrypted status secret',
      settlementReason: 'decrypted settlement secret',
    })
    const handler = commandRegistry.get<Record<string, unknown>, PatientVisit>('patient.visits.settle')
    if (!handler?.captureAfter) throw new Error('[internal] Missing lifecycle audit capture')
    const snapshot = await handler.captureAfter({}, harness.visit, harness.context)
    expect(snapshot).not.toHaveProperty('statusReason')
    expect(snapshot).not.toHaveProperty('settlementReason')
    expect(JSON.stringify(snapshot)).not.toContain('decrypted status secret')
    expect(JSON.stringify(snapshot)).not.toContain('decrypted settlement secret')
  })
})
