import { beforeAll, describe, expect, it } from '@jest/globals'
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
})
