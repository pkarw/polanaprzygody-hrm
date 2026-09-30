import { beforeAll, describe, expect, it, jest } from '@jest/globals'
import { commandRegistry } from '@open-mercato/shared/lib/commands'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

const createInput = {
  patientId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  startsAt: '2026-10-05T10:00:00+02:00',
  endsAt: null,
  timeZone: 'Europe/Warsaw',
  serviceProductIds: [],
  clientRequestId: '33333333-3333-4333-8333-333333333333',
}

function context(partial: Partial<CommandRuntimeContext>): CommandRuntimeContext {
  return {
    container: {} as CommandRuntimeContext['container'],
    auth: null,
    organizationScope: null,
    selectedOrganizationId: null,
    organizationIds: null,
    ...partial,
  }
}

describe('visit command registry', () => {
  beforeAll(async () => {
    if (!commandRegistry.get('patient.visits.create')) await import('../commands/visits')
  })

  it('registers CRUD handlers with guarded undo implementations', () => {
    for (const id of ['patient.visits.create', 'patient.visits.update', 'patient.visits.delete']) {
      const handler = commandRegistry.get(id)
      expect(handler).not.toBeNull()
      expect(handler?.isUndoable).toBe(true)
      expect(typeof handler?.undo).toBe('function')
    }
  })

  it('registers explicit non-undoable lifecycle handlers', () => {
    for (const id of [
      'patient.visits.confirm',
      'patient.visits.unconfirm',
      'patient.visits.transition',
      'patient.visits.settle',
      'patient.visits.unsettle',
    ]) {
      const handler = commandRegistry.get(id)
      expect(handler).not.toBeNull()
      expect(handler?.isUndoable).toBe(false)
      expect(handler?.undo).toBeUndefined()
    }
  })

  it('fails closed before touching dependencies when tenant or organization scope is absent', async () => {
    const handler = commandRegistry.get<Record<string, unknown>, unknown>('patient.visits.create')
    await expect(handler?.execute(createInput, context({ auth: null }))).rejects.toMatchObject({ status: 400 })
    await expect(handler?.execute(createInput, context({
      auth: { sub: 'user-1', tenantId: 'tenant-1', orgId: null },
    }))).rejects.toMatchObject({ status: 400 })
  })

  it('derives the actor from auth and refuses an actorless write', async () => {
    const handler = commandRegistry.get<Record<string, unknown>, unknown>('patient.visits.create')
    await expect(handler?.execute(createInput, context({
      auth: { sub: '', tenantId: 'tenant-1', orgId: 'org-1' },
      selectedOrganizationId: 'org-1',
    }))).rejects.toMatchObject({ status: 401 })
  })

  it.each([
    ['patient.visits.confirm', { id: createInput.patientId, expectedUpdatedAt: '2026-09-30T09:00:00.000Z' }, ['patient.visits.manage']],
    ['patient.visits.transition', { id: createInput.patientId, expectedUpdatedAt: '2026-09-30T09:00:00.000Z', status: 'planned', reason: 'Correction' }, ['patient.visits.manage', 'patient.visits.correct']],
    ['patient.visits.settle', { id: createInput.patientId, expectedUpdatedAt: '2026-09-30T09:00:00.000Z' }, ['patient.visits.settle']],
  ] as const)('fails closed at command-level ACL for %s', async (id, input, required) => {
    const userHasAllFeatures = jest.fn<(
      userId: string,
      requiredFeatures: string[],
      scope: { tenantId: string | null; organizationId: string | null },
    ) => Promise<boolean>>(async () => false)
    const resolve = jest.fn((token: string) => {
      if (token === 'rbacService') return { userHasAllFeatures }
      throw new Error(`[internal] Unexpected dependency ${token}`)
    })
    const handler = commandRegistry.get<Record<string, unknown>, unknown>(id)
    await expect(handler?.execute(input, context({
      container: { resolve } as unknown as CommandRuntimeContext['container'],
      auth: { sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1' },
      selectedOrganizationId: 'org-1',
    }))).rejects.toMatchObject({ status: 403, body: { code: 'visit_action_forbidden' } })
    expect(userHasAllFeatures).toHaveBeenCalledWith(
      'user-1',
      [...required],
      { tenantId: 'tenant-1', organizationId: 'org-1' },
    )
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
