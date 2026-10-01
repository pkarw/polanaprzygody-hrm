import { describe, expect, it, jest } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  StaffTeam,
  StaffTeamMember,
  StaffTeamRole,
} from '@open-mercato/core/modules/staff/data/entities'
import { CustomFieldEntityConfig } from '@open-mercato/core/modules/entities/data/entities'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { POLANA_THERAPIST_TEAM, POLANA_THERAPISTS } from '../lib/therapistFixtures'
import { seedPolanaTherapists, writeTherapistCustomFields } from '../lib/staffBootstrap'

jest.mock('@open-mercato/core/modules/entities/lib/field-definitions', () => ({
  ensureCustomFieldDefinitions: jest.fn(async () => undefined),
}))

describe('Polana staff custom fields', () => {
  it('writes the complete profile through DataEngine and requests standard reindex notification', async () => {
    const setCustomFields = jest.fn(async (_options: Parameters<DataEngine['setCustomFields']>[0]) => {})
    const fixture = POLANA_THERAPISTS[0]

    await writeTherapistCustomFields(
      { setCustomFields },
      { tenantId: 'tenant-1', organizationId: 'organization-1' },
      'member-1',
      fixture,
    )

    expect(setCustomFields).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 'staff:staff_team_member',
      recordId: 'member-1',
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      notify: true,
      values: expect.objectContaining({
        polana_source_id: fixture.sourceId,
        polana_experience: fixture.experience,
        polana_full_bio: fixture.fullDescription,
        polana_specializations: [...fixture.specializations],
      }),
    }))
  })

  it('assigns the required schedule to new therapists and repairs existing therapists', async () => {
    const scope = { tenantId: 'tenant-1', organizationId: 'organization-1' }
    const availabilityRuleSetId = 'availability-rule-set-1'
    const team = {
      id: 'team-1',
      ...scope,
      name: POLANA_THERAPIST_TEAM.name,
      description: 'old',
      isActive: true,
      deletedAt: null,
      updatedAt: new Date(0),
    }
    const roles = new Map(
      Array.from(new Set(POLANA_THERAPISTS.flatMap((therapist) => therapist.roles))).map((name, index) => [
        name,
        { id: `role-${index}`, name, deletedAt: null, updatedAt: new Date(0) },
      ]),
    )
    const existingMembers = new Map(POLANA_THERAPISTS.slice(0, 2).map((fixture, index) => [
      fixture.displayName,
      {
        id: `existing-member-${index}`,
        displayName: fixture.displayName,
        availabilityRuleSetId: null,
        description: 'old',
        roleIds: [],
        tags: [],
        isActive: true,
        deletedAt: null,
        updatedAt: new Date(0),
      },
    ]))
    const createdMembers: Array<Record<string, unknown>> = []
    const config = {
      configJson: { fieldsets: [] },
      isActive: true,
      updatedAt: new Date(0),
    }
    const em = {
      find: jest.fn(async () => []),
      findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
        if (entity === CustomFieldEntityConfig) return config
        if (entity === StaffTeam) return team
        if (entity === StaffTeamRole) return roles.get(String(where.name)) ?? null
        if (entity === StaffTeamMember) return existingMembers.get(String(where.displayName)) ?? null
        return null
      }),
      create: jest.fn((entity: unknown, values: Record<string, unknown>) => {
        if (entity !== StaffTeamMember) throw new Error('Unexpected entity creation in therapist repair test.')
        const member = { id: `created-member-${createdMembers.length}`, ...values }
        createdMembers.push(member)
        return member
      }),
      persist: jest.fn(),
      flush: jest.fn(async () => undefined),
      nativeDelete: jest.fn(async () => 0),
    } as unknown as EntityManager
    const setCustomFields = jest.fn(async (_options: Parameters<DataEngine['setCustomFields']>[0]) => {})

    await seedPolanaTherapists(em, { setCustomFields }, scope, availabilityRuleSetId)

    expect([...existingMembers.values()].every((member) => (
      member.availabilityRuleSetId === availabilityRuleSetId
    ))).toBe(true)
    expect(createdMembers).toHaveLength(2)
    expect(createdMembers.every((member) => (
      member.availabilityRuleSetId === availabilityRuleSetId
    ))).toBe(true)
    expect(setCustomFields).toHaveBeenCalledTimes(POLANA_THERAPISTS.length)
  })

  it('refuses to seed therapists without a resolved schedule', async () => {
    const setCustomFields = jest.fn(async (_options: Parameters<DataEngine['setCustomFields']>[0]) => {})

    await expect(seedPolanaTherapists(
      {} as EntityManager,
      { setCustomFields },
      { tenantId: 'tenant-1', organizationId: 'organization-1' },
      '',
    )).rejects.toThrow('requires availabilityRuleSetId')
  })
})
