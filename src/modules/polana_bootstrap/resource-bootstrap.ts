import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ResourcesResource,
  ResourcesResourceTag,
  ResourcesResourceTagAssignment,
  ResourcesResourceType,
} from '@open-mercato/core/modules/resources/data/entities'
import { PlannerAvailabilityRuleSet } from '@open-mercato/core/modules/planner/data/entities'
import {
  Dictionary,
  DictionaryEntry,
  type DictionaryManagerVisibility,
} from '@open-mercato/core/modules/dictionaries/data/entities'
import { RESOURCES_CAPACITY_UNIT_DICTIONARY_KEY } from '@open-mercato/core/modules/resources/lib/capacityUnits'
import { CustomFieldEntityConfig } from '@open-mercato/core/modules/entities/data/entities'
import { ensureCustomFieldDefinitions } from '@open-mercato/core/modules/entities/lib/field-definitions'
import { CommandBus, type CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { E } from '@/.mercato/generated/entities.ids.generated'
import type { BootstrapScope } from './customer-bootstrap'
import {
  LEGACY_RESOURCE_NAMES,
  LEGACY_RESOURCE_TAG_SLUGS,
  LEGACY_RESOURCE_TYPE_NAMES,
  POLANA_AVAILABILITY_RULE_SET,
  POLANA_AVAILABILITY_TIMEZONE,
  POLANA_AVAILABILITY_WINDOWS,
  POLANA_CAPACITY_UNIT,
  POLANA_RESOURCES,
  POLANA_RESOURCE_TAGS,
  POLANA_RESOURCE_TYPES,
  POLANA_ROOM_ADDRESS,
  POLANA_ROOM_FIELDS,
  POLANA_ROOM_FIELDSET,
  POLANA_ROOM_FIELDSET_DEFINITION,
  type PolanaResourceFixture,
} from './resource-fixtures'

type ResourceRecord = { id: string; name: string; resourceTypeId: string | null }
type ResourceTypeRecord = { id: string; name: string }
type ResourceTagRecord = { id: string; slug: string }
type TagAssignmentRecord = { tagId: string; resourceId: string }
type RuleSetRecord = { id: string; name: string }

export type ResourceCustomFieldValues = Record<string, string | number | boolean | string[] | null>

export type ResourceBootstrapDependencies = {
  ensureFields(scope: BootstrapScope): Promise<void>
  ensureCapacityUnit(scope: BootstrapScope): Promise<void>
  listResources(scope: BootstrapScope): Promise<ResourceRecord[]>
  listResourceTypes(scope: BootstrapScope): Promise<ResourceTypeRecord[]>
  listResourceTags(scope: BootstrapScope): Promise<ResourceTagRecord[]>
  listAvailabilityRuleSets(scope: BootstrapScope): Promise<RuleSetRecord[]>
  listTagAssignments(scope: BootstrapScope): Promise<TagAssignmentRecord[]>
  execute(commandId: string, input: Record<string, unknown>, scope: BootstrapScope): Promise<unknown>
  setResourceFields(recordId: string, values: ResourceCustomFieldValues, scope: BootstrapScope): Promise<void>
}

export type ResourceBootstrapPlan = {
  resourcesToRemove: string[]
  resourceTypesToRemove: string[]
  resourceTagsToRemove: string[]
  resourceTypesToCreate: string[]
  resourceTagsToCreate: string[]
  resourcesToCreate: string[]
  resourcesToUpdate: string[]
  availabilityRuleSetToCreate: boolean
}

export type ResourceBootstrapSummary = {
  removedResources: number
  removedResourceTypes: number
  removedResourceTags: number
  createdResourceTypes: number
  createdResourceTags: number
  createdResources: number
  updatedResources: number
  availabilityRuleSetId: string | null
}

function assertScope(scope: BootstrapScope): void {
  if (!scope.tenantId || !scope.organizationId) {
    throw new Error('Polana resource bootstrap requires tenantId and organizationId.')
  }
}

/** Address is identical for every gabinet, so it is merged in from one place. */
export function buildResourceCustomFieldValues(fixture: PolanaResourceFixture): ResourceCustomFieldValues {
  return {
    polana_room_address_street: POLANA_ROOM_ADDRESS.street,
    polana_room_address_postal_code: POLANA_ROOM_ADDRESS.postalCode,
    polana_room_address_city: POLANA_ROOM_ADDRESS.city,
    polana_room_address_country: POLANA_ROOM_ADDRESS.country,
    polana_room_floor: fixture.customFields.polana_room_floor,
    polana_room_area_sqm: fixture.customFields.polana_room_area_sqm,
    polana_room_therapy_types: [...fixture.customFields.polana_room_therapy_types],
    polana_room_equipment: fixture.customFields.polana_room_equipment,
    polana_room_wheelchair_accessible: fixture.customFields.polana_room_wheelchair_accessible,
    polana_room_access_notes: fixture.customFields.polana_room_access_notes,
  }
}

function resourceInput(
  fixture: PolanaResourceFixture,
  scope: BootstrapScope,
  refs: { resourceTypeId: string | null; tagIds: string[]; availabilityRuleSetId: string | null },
): Record<string, unknown> {
  return {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    name: fixture.name,
    description: fixture.description,
    resourceTypeId: refs.resourceTypeId,
    capacity: fixture.capacity,
    capacityUnitValue: POLANA_CAPACITY_UNIT.value,
    tags: refs.tagIds,
    appearanceIcon: fixture.appearanceIcon,
    appearanceColor: fixture.appearanceColor,
    isActive: true,
    availabilityRuleSetId: refs.availabilityRuleSetId,
    customFieldsetCode: POLANA_ROOM_FIELDSET,
  }
}

type RunOptions = { execute?: boolean }

async function run(
  dependencies: ResourceBootstrapDependencies,
  scope: BootstrapScope,
  options: RunOptions = {},
): Promise<{ plan: ResourceBootstrapPlan; summary: ResourceBootstrapSummary }> {
  assertScope(scope)
  const write = options.execute === true
  const plan: ResourceBootstrapPlan = {
    resourcesToRemove: [],
    resourceTypesToRemove: [],
    resourceTagsToRemove: [],
    resourceTypesToCreate: [],
    resourceTagsToCreate: [],
    resourcesToCreate: [],
    resourcesToUpdate: [],
    availabilityRuleSetToCreate: false,
  }
  const summary: ResourceBootstrapSummary = {
    removedResources: 0,
    removedResourceTypes: 0,
    removedResourceTags: 0,
    createdResourceTypes: 0,
    createdResourceTags: 0,
    createdResources: 0,
    updatedResources: 0,
    availabilityRuleSetId: null,
  }

  if (write) {
    await dependencies.ensureFields(scope)
    await dependencies.ensureCapacityUnit(scope)
  }

  // 1. Drop the core `resources` example set before creating the real gabinets.
  const legacyResourceNames = new Set<string>(LEGACY_RESOURCE_NAMES.map((name) => name.toLowerCase()))
  const resources = await dependencies.listResources(scope)
  const legacyResources = resources.filter((resource) => legacyResourceNames.has(resource.name.toLowerCase()))
  plan.resourcesToRemove = legacyResources.map((resource) => resource.name)
  const removedResourceIds = new Set<string>()
  for (const resource of legacyResources) {
    if (write) await dependencies.execute('resources.resources.delete', { id: resource.id }, scope)
    removedResourceIds.add(resource.id)
    summary.removedResources += 1
  }

  const survivingResources = resources.filter((resource) => !removedResourceIds.has(resource.id))

  const legacyTypeNames = new Set<string>(LEGACY_RESOURCE_TYPE_NAMES.map((name) => name.toLowerCase()))
  const resourceTypes = await dependencies.listResourceTypes(scope)
  // `resourceTypes.delete` refuses a type that still has live resources, so only
  // the types left orphaned by the removal above are dropped.
  const survivingTypeIds = new Set(
    survivingResources
      .map((resource) => resource.resourceTypeId)
      .filter((id): id is string => typeof id === 'string'),
  )
  const legacyTypes = resourceTypes.filter((type) => (
    legacyTypeNames.has(type.name.toLowerCase()) && !survivingTypeIds.has(type.id)
  ))
  plan.resourceTypesToRemove = legacyTypes.map((type) => type.name)
  for (const type of legacyTypes) {
    if (write) await dependencies.execute('resources.resourceTypes.delete', { id: type.id }, scope)
    summary.removedResourceTypes += 1
  }

  const legacyTagSlugs = new Set<string>(LEGACY_RESOURCE_TAG_SLUGS.map((slug) => slug.toLowerCase()))
  const resourceTags = await dependencies.listResourceTags(scope)
  const legacyTags = resourceTags.filter((tag) => legacyTagSlugs.has(tag.slug.toLowerCase()))
  // Deleting a resource only soft-deletes it; its tag assignments stay behind.
  // Orphan detection therefore has to ignore assignments pointing at anything
  // this run removed, or no legacy tag would ever look unused.
  const survivingResourceIds = new Set(survivingResources.map((resource) => resource.id))
  const assignments = legacyTags.length > 0 ? await dependencies.listTagAssignments(scope) : []
  const liveTagIds = new Set(
    assignments
      .filter((assignment) => survivingResourceIds.has(assignment.resourceId))
      .map((assignment) => assignment.tagId),
  )
  for (const tag of legacyTags) {
    // A tag reused by a resource the operator created stays; only orphans go.
    if (liveTagIds.has(tag.id)) continue
    plan.resourceTagsToRemove.push(tag.slug)
    if (write) await dependencies.execute('resources.resourceTags.delete', { id: tag.id }, scope)
    summary.removedResourceTags += 1
  }

  // 2. One shared availability rule set: every day 09:00–19:00.
  const ruleSets = await dependencies.listAvailabilityRuleSets(scope)
  const existingRuleSet = ruleSets.find((ruleSet) => (
    ruleSet.name.trim().toLowerCase() === POLANA_AVAILABILITY_RULE_SET.name.toLowerCase()
  )) ?? null
  plan.availabilityRuleSetToCreate = existingRuleSet === null
  let availabilityRuleSetId = existingRuleSet?.id ?? null
  if (write) {
    if (!availabilityRuleSetId) {
      const created = await dependencies.execute('planner.availability-rule-sets.create', {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        name: POLANA_AVAILABILITY_RULE_SET.name,
        description: POLANA_AVAILABILITY_RULE_SET.description,
        timezone: POLANA_AVAILABILITY_RULE_SET.timezone,
      }, scope) as { ruleSetId?: string } | null
      availabilityRuleSetId = created?.ruleSetId ?? null
      if (!availabilityRuleSetId) throw new Error('Availability rule set creation returned no id.')
    }
    // `weekly.replace` is declarative: it clears the recurring rules it owns and
    // writes the requested windows, so re-running the bootstrap never stacks them.
    await dependencies.execute('planner.availability.weekly.replace', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      subjectType: 'ruleset',
      subjectId: availabilityRuleSetId,
      timezone: POLANA_AVAILABILITY_TIMEZONE,
      windows: POLANA_AVAILABILITY_WINDOWS,
    }, scope)
  }
  summary.availabilityRuleSetId = availabilityRuleSetId

  // 3. Polana resource types.
  const typeIdByKey = new Map<string, string>()
  const remainingTypes = resourceTypes.filter((type) => !legacyTypes.some((legacy) => legacy.id === type.id))
  const typeByName = new Map(remainingTypes.map((type) => [type.name.toLowerCase(), type]))
  for (const fixture of POLANA_RESOURCE_TYPES) {
    const existing = typeByName.get(fixture.name.toLowerCase())
    if (existing) {
      typeIdByKey.set(fixture.key, existing.id)
      continue
    }
    plan.resourceTypesToCreate.push(fixture.name)
    if (!write) continue
    const created = await dependencies.execute('resources.resourceTypes.create', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      name: fixture.name,
      description: fixture.description,
      appearanceIcon: fixture.appearanceIcon,
      appearanceColor: fixture.appearanceColor,
    }, scope) as { resourceTypeId?: string } | null
    const createdId = created?.resourceTypeId ?? null
    if (!createdId) throw new Error(`Resource type creation returned no id: ${fixture.name}`)
    typeIdByKey.set(fixture.key, createdId)
    summary.createdResourceTypes += 1
  }

  // 4. Polana tags.
  const tagIdByKey = new Map<string, string>()
  const remainingTags = resourceTags.filter((tag) => !plan.resourceTagsToRemove.includes(tag.slug))
  const tagBySlug = new Map(remainingTags.map((tag) => [tag.slug.toLowerCase(), tag]))
  for (const fixture of POLANA_RESOURCE_TAGS) {
    const existing = tagBySlug.get(fixture.slug.toLowerCase())
    if (existing) {
      tagIdByKey.set(fixture.key, existing.id)
      continue
    }
    plan.resourceTagsToCreate.push(fixture.slug)
    if (!write) continue
    const created = await dependencies.execute('resources.resourceTags.create', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      slug: fixture.slug,
      label: fixture.label,
      color: fixture.color,
    }, scope) as { tagId?: string } | null
    const createdId = created?.tagId ?? null
    if (!createdId) throw new Error(`Resource tag creation returned no id: ${fixture.slug}`)
    tagIdByKey.set(fixture.key, createdId)
    summary.createdResourceTags += 1
  }

  // 5. The gabinets themselves.
  const resourceByName = new Map(survivingResources.map((resource) => [resource.name.toLowerCase(), resource]))
  for (const fixture of POLANA_RESOURCES) {
    const refs = {
      resourceTypeId: typeIdByKey.get(fixture.typeKey) ?? null,
      tagIds: fixture.tagKeys.map((key) => tagIdByKey.get(key)).filter((id): id is string => typeof id === 'string'),
      availabilityRuleSetId,
    }
    const existing = resourceByName.get(fixture.name.toLowerCase())
    if (existing) {
      plan.resourcesToUpdate.push(fixture.name)
      if (!write) continue
      await dependencies.execute('resources.resources.update', {
        id: existing.id,
        ...resourceInput(fixture, scope, refs),
      }, scope)
      await dependencies.setResourceFields(existing.id, buildResourceCustomFieldValues(fixture), scope)
      summary.updatedResources += 1
      continue
    }
    plan.resourcesToCreate.push(fixture.name)
    if (!write) continue
    const created = await dependencies.execute(
      'resources.resources.create',
      resourceInput(fixture, scope, refs),
      scope,
    ) as { resourceId?: string } | null
    const createdId = created?.resourceId ?? null
    if (!createdId) throw new Error(`Resource creation returned no id: ${fixture.name}`)
    await dependencies.setResourceFields(createdId, buildResourceCustomFieldValues(fixture), scope)
    summary.createdResources += 1
  }

  return { plan, summary }
}

export async function planPolanaResources(
  dependencies: ResourceBootstrapDependencies,
  scope: BootstrapScope,
): Promise<ResourceBootstrapPlan> {
  const { plan } = await run(dependencies, scope)
  return plan
}

export async function seedPolanaResources(
  dependencies: ResourceBootstrapDependencies,
  scope: BootstrapScope,
): Promise<ResourceBootstrapSummary> {
  const { summary } = await run(dependencies, scope, { execute: true })
  return summary
}

function commandContext(container: AwilixContainer, scope: BootstrapScope): CommandRuntimeContext {
  return {
    container,
    auth: { sub: 'system:polana_bootstrap', userId: 'system:polana_bootstrap', tenantId: scope.tenantId, orgId: scope.organizationId },
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    syncOrigin: 'polana_bootstrap:setup',
    systemActor: true,
  }
}

export function createResourceBootstrapDependencies(
  em: EntityManager,
  container: AwilixContainer,
): ResourceBootstrapDependencies {
  const commandBus = container.resolve<CommandBus>('commandBus')
  const dataEngine = container.resolve<DataEngine>('dataEngine')
  return {
    ensureFields: async (scope) => {
      const now = new Date()
      let config = await em.findOne(CustomFieldEntityConfig, { entityId: E.resources.resources_resource, ...scope })
      if (!config) {
        config = em.create(CustomFieldEntityConfig, {
          entityId: E.resources.resources_resource,
          ...scope,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
      }
      const current = config.configJson && typeof config.configJson === 'object'
        ? config.configJson as Record<string, unknown>
        : {}
      const currentFieldsets = Array.isArray(current.fieldsets) ? current.fieldsets : []
      // The core `resources` seed rewrites this config with its own fieldsets on
      // every install, so append ours instead of replacing the list; this hook
      // runs after core's and stays idempotent across re-runs.
      const withoutPolana = currentFieldsets.filter((fieldset) => (
        !fieldset || typeof fieldset !== 'object' || (fieldset as { code?: unknown }).code !== POLANA_ROOM_FIELDSET
      ))
      config.configJson = {
        ...current,
        fieldsets: [...withoutPolana, POLANA_ROOM_FIELDSET_DEFINITION],
      }
      config.isActive = true
      config.updatedAt = now
      em.persist(config)
      await ensureCustomFieldDefinitions(em, [{
        entity: E.resources.resources_resource,
        fields: POLANA_ROOM_FIELDS,
        source: 'polana_bootstrap',
      }], scope)
      await em.flush()
    },
    ensureCapacityUnit: async (scope) => {
      const now = new Date()
      let dictionary = await em.findOne(Dictionary, {
        ...scope,
        key: RESOURCES_CAPACITY_UNIT_DICTIONARY_KEY,
        deletedAt: null,
      })
      if (!dictionary) {
        dictionary = em.create(Dictionary, {
          key: RESOURCES_CAPACITY_UNIT_DICTIONARY_KEY,
          name: 'Resource capacity units',
          description: 'Units for resource capacity (spots, units, quantity, etc.).',
          ...scope,
          isSystem: true,
          isActive: true,
          managerVisibility: 'default' satisfies DictionaryManagerVisibility,
          createdAt: now,
          updatedAt: now,
        })
        em.persist(dictionary)
        await em.flush()
      }
      const normalizedValue = POLANA_CAPACITY_UNIT.value.toLowerCase()
      const existing = await em.findOne(DictionaryEntry, { dictionary, ...scope, normalizedValue })
      if (existing) return
      em.persist(em.create(DictionaryEntry, {
        dictionary,
        ...scope,
        value: POLANA_CAPACITY_UNIT.value,
        normalizedValue,
        label: POLANA_CAPACITY_UNIT.label,
        color: null,
        icon: null,
        createdAt: now,
        updatedAt: now,
      }))
      await em.flush()
    },
    listResources: async (scope) => (await em.find(ResourcesResource, { ...scope, deletedAt: null })).map((item) => ({
      id: item.id,
      name: item.name,
      resourceTypeId: item.resourceTypeId ?? null,
    })),
    listResourceTypes: async (scope) => (await em.find(ResourcesResourceType, { ...scope, deletedAt: null })).map((item) => ({
      id: item.id,
      name: item.name,
    })),
    // Resource tags are hard-deleted and unique per (org, tenant, slug), so the
    // active rows are the whole picture — there is no soft-deleted slug to collide with.
    listResourceTags: async (scope) => (await em.find(ResourcesResourceTag, { ...scope })).map((item) => ({
      id: item.id,
      slug: item.slug,
    })),
    listAvailabilityRuleSets: async (scope) => (await em.find(PlannerAvailabilityRuleSet, { ...scope, deletedAt: null })).map((item) => ({
      id: item.id,
      name: item.name,
    })),
    listTagAssignments: async (scope) => (
      await em.find(ResourcesResourceTagAssignment, { ...scope }, { populate: ['resource', 'tag'] })
    ).flatMap((item) => {
      const tagId = typeof item.tag === 'string' ? item.tag : item.tag?.id
      const resourceId = typeof item.resource === 'string' ? item.resource : item.resource?.id
      if (!tagId || !resourceId) return []
      return [{ tagId, resourceId }]
    }),
    execute: async (commandId, input, scope) => (
      await commandBus.execute(commandId, { input, ctx: commandContext(container, scope) })
    ).result,
    setResourceFields: async (recordId, values, scope) => dataEngine.setCustomFields({
      entityId: E.resources.resources_resource,
      recordId,
      ...scope,
      values,
      notify: true,
    }),
  }
}
