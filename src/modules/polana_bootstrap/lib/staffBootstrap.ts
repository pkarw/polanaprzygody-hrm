import type { EntityManager } from '@mikro-orm/postgresql'
import {
  StaffTeam,
  StaffTeamMember,
  StaffTeamMemberActivity,
  StaffTeamMemberAddress,
  StaffTeamMemberComment,
  StaffTeamMemberJobHistory,
  StaffTeamRole,
} from '@open-mercato/core/modules/staff/data/entities'
import { CustomFieldEntityConfig, CustomFieldValue } from '@open-mercato/core/modules/entities/data/entities'
import { ensureCustomFieldDefinitions } from '@open-mercato/core/modules/entities/lib/field-definitions'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'
import { E } from '@/.mercato/generated/entities.ids.generated'
import {
  POLANA_THERAPIST_TEAM,
  POLANA_THERAPISTS,
  POLANA_THERAPISTS_CAPTURED_AT,
  POLANA_THERAPISTS_SOURCE_URL,
} from './therapistFixtures'

export type PolanaBootstrapScope = { tenantId: string; organizationId: string }

type CustomFieldWriter = Pick<DataEngine, 'setCustomFields'>
type TherapistFixture = (typeof POLANA_THERAPISTS)[number]

const PROFILE_FIELDSET = 'polana_therapist_profile'
const LEGACY_EXAMPLE_TEAM_NAMES = ['Engineering', 'Product', 'Operations'] as const
const LEGACY_EXAMPLE_MEMBER_NAMES = ['Alex Chen', 'Priya Nair', 'Marta Lopez', 'Samir Haddad', 'Jordan Kim'] as const

const THERAPIST_FIELDS: CustomFieldDefinition[] = [
  { key: 'polana_source_id', kind: 'text', label: 'Identyfikator źródłowy', formEditable: false, indexed: true, fieldset: PROFILE_FIELDSET },
  { key: 'polana_source_url', kind: 'text', label: 'Strona źródłowa', formEditable: true, fieldset: PROFILE_FIELDSET },
  { key: 'polana_photo_url', kind: 'text', label: 'Zdjęcie', formEditable: true, fieldset: PROFILE_FIELDSET },
  { key: 'polana_experience', kind: 'text', label: 'Doświadczenie', formEditable: true, listVisible: true, fieldset: PROFILE_FIELDSET },
  { key: 'polana_short_bio', kind: 'multiline', label: 'Krótki opis', formEditable: true, editor: 'simpleMarkdown', fieldset: PROFILE_FIELDSET },
  { key: 'polana_full_bio', kind: 'multiline', label: 'Pełny opis', formEditable: true, editor: 'simpleMarkdown', fieldset: PROFILE_FIELDSET },
  { key: 'polana_quote', kind: 'multiline', label: 'Cytat', formEditable: true, fieldset: PROFILE_FIELDSET },
  { key: 'polana_specializations', kind: 'text', label: 'Specjalizacje', multi: true, formEditable: true, input: 'tags', fieldset: PROFILE_FIELDSET },
  { key: 'polana_booking_url', kind: 'text', label: 'Link do rezerwacji', formEditable: true, fieldset: PROFILE_FIELDSET },
  { key: 'polana_source_captured_at', kind: 'text', label: 'Data snapshotu źródła', formEditable: false, fieldset: PROFILE_FIELDSET },
]

function assertScope(scope: PolanaBootstrapScope): void {
  if (!scope.tenantId || !scope.organizationId) {
    throw new Error('Polana therapist bootstrap requires tenantId and organizationId.')
  }
}

export async function writeTherapistCustomFields(
  writer: CustomFieldWriter,
  scope: PolanaBootstrapScope,
  recordId: string,
  fixture: TherapistFixture,
): Promise<void> {
  await writer.setCustomFields({
    entityId: E.staff.staff_team_member,
    recordId,
    ...scope,
    values: {
      polana_source_id: fixture.sourceId,
      polana_source_url: `${POLANA_THERAPISTS_SOURCE_URL}#${fixture.sourceId}`,
      polana_photo_url: fixture.photoUrl,
      polana_experience: fixture.experience,
      polana_short_bio: fixture.shortDescription,
      polana_full_bio: fixture.fullDescription,
      polana_quote: fixture.quote,
      polana_specializations: [...fixture.specializations],
      polana_booking_url: fixture.bookingUrl,
      polana_source_captured_at: POLANA_THERAPISTS_CAPTURED_AT,
    },
    notify: true,
  })
}

async function removeLegacyStaffExamples(em: EntityManager, scope: PolanaBootstrapScope): Promise<void> {
  const members = await em.find(StaffTeamMember, {
    ...scope,
    displayName: { $in: [...LEGACY_EXAMPLE_MEMBER_NAMES] },
  }, { fields: ['id'] })
  const memberIds = members.map((member) => member.id)
  if (memberIds.length > 0) {
    await em.nativeDelete(StaffTeamMemberComment, { member: { $in: memberIds } })
    await em.nativeDelete(StaffTeamMemberActivity, { member: { $in: memberIds } })
    await em.nativeDelete(StaffTeamMemberAddress, { member: { $in: memberIds } })
    await em.nativeDelete(StaffTeamMemberJobHistory, { member: { $in: memberIds } })
    await em.nativeDelete(CustomFieldValue, {
      entityId: E.staff.staff_team_member,
      recordId: { $in: memberIds },
      ...scope,
    })
    await em.nativeDelete(StaffTeamMember, { id: { $in: memberIds }, ...scope })
  }

  const teams = await em.find(StaffTeam, {
    ...scope,
    name: { $in: [...LEGACY_EXAMPLE_TEAM_NAMES] },
  }, { fields: ['id'] })
  const teamIds = teams.map((team) => team.id)
  if (teamIds.length > 0) {
    await em.nativeDelete(StaffTeamRole, { teamId: { $in: teamIds }, ...scope })
    await em.nativeDelete(StaffTeam, { id: { $in: teamIds }, ...scope })
  }
}

async function ensureProfileFields(em: EntityManager, scope: PolanaBootstrapScope): Promise<void> {
  const now = new Date()
  let config = await em.findOne(CustomFieldEntityConfig, {
    entityId: E.staff.staff_team_member,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  if (!config) {
    config = em.create(CustomFieldEntityConfig, {
      entityId: E.staff.staff_team_member,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
  }
  const existingConfig = config.configJson && typeof config.configJson === 'object'
    ? config.configJson as Record<string, unknown>
    : {}
  const existingFieldsets = Array.isArray(existingConfig.fieldsets) ? existingConfig.fieldsets : []
  const withoutPolana = existingFieldsets.filter((fieldset) => {
    return !fieldset || typeof fieldset !== 'object' || (fieldset as { code?: unknown }).code !== PROFILE_FIELDSET
  })
  config.configJson = {
    ...existingConfig,
    fieldsets: [
      ...withoutPolana,
      {
        code: PROFILE_FIELDSET,
        label: 'Profil terapeuty Polany Przygody',
        description: 'Publiczne informacje zachowane ze strony polanaprzygody.pl/terapeuci.',
      },
    ],
    singleFieldsetPerRecord: false,
  }
  config.isActive = true
  config.updatedAt = now
  em.persist(config)

  await ensureCustomFieldDefinitions(em, [{
    entity: E.staff.staff_team_member,
    fields: THERAPIST_FIELDS,
    source: 'polana_bootstrap',
  }], scope)
  await em.flush()
}

export async function seedPolanaTherapists(
  em: EntityManager,
  customFieldWriter: CustomFieldWriter,
  scope: PolanaBootstrapScope,
): Promise<void> {
  assertScope(scope)
  await removeLegacyStaffExamples(em, scope)
  await ensureProfileFields(em, scope)

  const now = new Date()
  let team = await em.findOne(StaffTeam, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    name: POLANA_THERAPIST_TEAM.name,
  })
  if (!team) {
    team = em.create(StaffTeam, {
      ...scope,
      name: POLANA_THERAPIST_TEAM.name,
      description: POLANA_THERAPIST_TEAM.description,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
  } else {
    team.description = POLANA_THERAPIST_TEAM.description
    team.isActive = true
    team.deletedAt = null
    team.updatedAt = now
  }
  em.persist(team)
  await em.flush()

  const roleNames = Array.from(new Set(POLANA_THERAPISTS.flatMap((therapist) => therapist.roles)))
  const rolesByName = new Map<string, StaffTeamRole>()
  for (const name of roleNames) {
    let role = await em.findOne(StaffTeamRole, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      teamId: team.id,
      name,
    })
    if (!role) {
      role = em.create(StaffTeamRole, {
        ...scope,
        teamId: team.id,
        name,
        description: `Rola w zespole ${POLANA_THERAPIST_TEAM.name}.`,
        appearanceIcon: 'lucide:heart-handshake',
        appearanceColor: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
    } else {
      role.deletedAt = null
      role.updatedAt = now
    }
    em.persist(role)
    rolesByName.set(name, role)
  }
  await em.flush()

  for (const fixture of POLANA_THERAPISTS) {
    let member = await em.findOne(StaffTeamMember, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      teamId: team.id,
      displayName: fixture.displayName,
    })
    const roleIds = fixture.roles.map((roleName) => {
      const role = rolesByName.get(roleName)
      if (!role) throw new Error(`Missing seeded therapist role: ${roleName}`)
      return role.id
    })
    if (!member) {
      member = em.create(StaffTeamMember, {
        ...scope,
        teamId: team.id,
        displayName: fixture.displayName,
        description: fixture.shortDescription,
        userId: null,
        roleIds,
        tags: [...fixture.specializations],
        availabilityRuleSetId: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
    } else {
      member.description = fixture.shortDescription
      member.roleIds = roleIds
      member.tags = [...fixture.specializations]
      member.isActive = true
      member.deletedAt = null
      member.updatedAt = now
    }
    em.persist(member)
    await em.flush()

    await writeTherapistCustomFields(customFieldWriter, scope, member.id, fixture)
  }
}
