import { describe, expect, it, jest } from '@jest/globals'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { assertConflictDecision } from '../commands/visits'
import type { VisitConflict } from '../lib/visitConflicts'

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }

function conflict(severity: VisitConflict['severity'], signature = 'a'.repeat(64)): VisitConflict {
  return {
    code: severity === 'blocking' ? 'member_absence' : 'member_double_booked',
    severity,
    subjectType: 'member',
    subjectId: '11111111-1111-4111-8111-111111111111',
    subjectName: 'Anna Nowicka',
    from: '2026-09-30T10:00:00.000Z',
    to: '2026-09-30T11:00:00.000Z',
    signature,
  }
}

function ctx(granted = true) {
  const userHasAllFeatures = jest.fn<(
    userId: string,
    required: string[],
    checkedScope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<boolean>>(async () => granted)
  const resolve = jest.fn((token: string) => {
    if (token === 'rbacService') return { userHasAllFeatures }
    throw new Error(`[internal] Unexpected dependency ${token}`)
  })
  return {
    value: {
      container: { resolve } as unknown as CommandRuntimeContext['container'],
      auth: { sub: 'user-1', tenantId: scope.tenantId, orgId: scope.organizationId },
      selectedOrganizationId: scope.organizationId,
      organizationScope: null,
      organizationIds: null,
    } as CommandRuntimeContext,
    userHasAllFeatures,
  }
}

describe('visit conflict decisions', () => {
  it('never permits a blocking conflict', async () => {
    await expect(assertConflictDecision(
      ctx().value,
      scope,
      [conflict('blocking')],
      { acknowledgedSignatures: ['a'.repeat(64)], reason: 'Emergency' },
    )).rejects.toMatchObject({ status: 422, body: { error: 'visit_conflict_blocking' } })
  })

  it('requires the exact warning signature set', async () => {
    const warning = conflict('warning')
    await expect(assertConflictDecision(ctx().value, scope, [warning], undefined))
      .rejects.toMatchObject({ status: 422, body: { error: 'visit_conflict_unacknowledged' } })
    await expect(assertConflictDecision(
      ctx().value,
      scope,
      [warning],
      { acknowledgedSignatures: [warning.signature, 'b'.repeat(64)], reason: 'Emergency' },
    )).rejects.toMatchObject({ status: 422, body: { error: 'visit_conflict_unacknowledged' } })
  })

  it('requires the override feature before accepting a warning', async () => {
    const warning = conflict('warning')
    const denied = ctx(false)
    await expect(assertConflictDecision(
      denied.value,
      scope,
      [warning],
      { acknowledgedSignatures: [warning.signature], reason: 'Emergency' },
    )).rejects.toMatchObject({ status: 403 })
    expect(denied.userHasAllFeatures).toHaveBeenCalledWith(
      'user-1',
      ['patient.visits.override_conflict'],
      scope,
    )
  })

  it('returns only stable codes and the validated reason for an accepted override', async () => {
    const warning = conflict('warning')
    await expect(assertConflictDecision(
      ctx().value,
      scope,
      [warning, { ...warning }],
      { acknowledgedSignatures: [warning.signature], reason: 'Emergency' },
    )).resolves.toEqual({ codes: ['member_double_booked'], reason: 'Emergency' })
  })

  it('needs no override for informational results', async () => {
    await expect(assertConflictDecision(ctx().value, scope, [conflict('info')], undefined))
      .resolves.toBeNull()
  })
})
