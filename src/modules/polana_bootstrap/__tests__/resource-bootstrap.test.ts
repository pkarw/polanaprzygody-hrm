import { describe, expect, it, jest } from '@jest/globals'
import {
  buildResourceCustomFieldValues,
  planPolanaResources,
  seedPolanaResources,
  type ResourceBootstrapDependencies,
  type ResourceCustomFieldValues,
} from '../resource-bootstrap'
import {
  LEGACY_RESOURCE_NAMES,
  LEGACY_RESOURCE_TAG_SLUGS,
  LEGACY_RESOURCE_TYPE_NAMES,
  POLANA_AVAILABILITY_WINDOWS,
  POLANA_CAPACITY_UNIT,
  POLANA_RESOURCES,
  POLANA_RESOURCE_TAGS,
  POLANA_RESOURCE_TYPES,
  POLANA_ROOM_ADDRESS,
  POLANA_ROOM_FIELDSET,
  isPolanaRoomFieldKey,
} from '../resource-fixtures'

const scope = { tenantId: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002' }

type ResourceRow = { id: string; name: string; resourceTypeId: string | null }

function coreExampleState() {
  const types = LEGACY_RESOURCE_TYPE_NAMES.map((name, index) => ({ id: `legacy-type-${index}`, name }))
  const typeByResource: Record<string, string> = {
    'Meeting Room A': 'legacy-type-0',
    'Meeting Room B': 'legacy-type-0',
    'Focus Room 1': 'legacy-type-1',
    'Focus Room 2': 'legacy-type-1',
    'Engineering Laptop 1': 'legacy-type-2',
    'Engineering Laptop 2': 'legacy-type-2',
    'Tesla Model 3 - WWA 4K32': 'legacy-type-3',
    'Volvo XC40 Recharge - WPR 9L18': 'legacy-type-3',
  }
  const resources: ResourceRow[] = LEGACY_RESOURCE_NAMES.map((name, index) => ({
    id: `legacy-resource-${index}`,
    name,
    resourceTypeId: typeByResource[name] ?? null,
  }))
  const tags = LEGACY_RESOURCE_TAG_SLUGS.map((slug, index) => ({ id: `legacy-tag-${index}`, slug }))
  return { types, resources, tags }
}

function dependenciesFor(state: {
  resources?: ResourceRow[]
  types?: Array<{ id: string; name: string }>
  tags?: Array<{ id: string; slug: string }>
  ruleSets?: Array<{ id: string; name: string }>
  tagAssignments?: Array<{ tagId: string; resourceId: string }>
} = {}) {
  const execute = jest.fn(async (commandId: string, input: Record<string, unknown>) => {
    if (commandId === 'resources.resourceTypes.create') return { resourceTypeId: `type-${String(input.name)}` }
    if (commandId === 'resources.resourceTags.create') return { tagId: `tag-${String(input.slug)}` }
    if (commandId === 'resources.resources.create') return { resourceId: `resource-${String(input.name)}` }
    if (commandId === 'planner.availability-rule-sets.create') return { ruleSetId: 'rule-set-1' }
    return {}
  })
  const setResourceFields = jest.fn(async (_recordId: string, _values: ResourceCustomFieldValues) => undefined)
  const dependencies = {
    ensureFields: jest.fn(async () => undefined),
    ensureCapacityUnit: jest.fn(async () => undefined),
    listResources: jest.fn(async () => state.resources ?? []),
    listResourceTypes: jest.fn(async () => state.types ?? []),
    listResourceTags: jest.fn(async () => state.tags ?? []),
    listAvailabilityRuleSets: jest.fn(async () => state.ruleSets ?? []),
    listTagAssignments: jest.fn(async () => state.tagAssignments ?? []),
    execute,
    setResourceFields,
  } satisfies ResourceBootstrapDependencies
  return { dependencies, execute, setResourceFields }
}

describe('Polana resource bootstrap', () => {
  it('removes the whole core example set and installs the four Polana rooms', async () => {
    const state = coreExampleState()
    const { dependencies, execute, setResourceFields } = dependenciesFor(state)

    const summary = await seedPolanaResources(dependencies, scope)

    expect(summary).toEqual({
      removedResources: 8,
      removedResourceTypes: 4,
      removedResourceTags: 6,
      createdResourceTypes: 2,
      createdResourceTags: 5,
      createdResources: 4,
      updatedResources: 0,
      availabilityRuleSetId: 'rule-set-1',
    })
    expect(execute.mock.calls.filter(([id]) => id === 'resources.resources.delete').map(([, input]) => input.id))
      .toEqual(state.resources.map((resource) => resource.id))
    expect(execute.mock.calls.filter(([id]) => id === 'resources.resourceTypes.delete')).toHaveLength(4)
    expect(execute.mock.calls.filter(([id]) => id === 'resources.resourceTags.delete')).toHaveLength(6)

    const created = execute.mock.calls.filter(([id]) => id === 'resources.resources.create').map(([, input]) => input)
    expect(created.map((input) => input.name)).toEqual([
      'Gabinet Psychologa',
      'Gabinet Logopedy',
      'Gabinet Neurologopedii',
      'Sala do ćwiczeń SI',
    ])
    expect(created.every((input) => input.customFieldsetCode === POLANA_ROOM_FIELDSET)).toBe(true)
    expect(created.every((input) => input.availabilityRuleSetId === 'rule-set-1')).toBe(true)
    expect(created.every((input) => input.capacityUnitValue === POLANA_CAPACITY_UNIT.value)).toBe(true)
    expect(created.every((input) => (
      input.tenantId === scope.tenantId && input.organizationId === scope.organizationId
    ))).toBe(true)
    expect(created.every((input) => Array.isArray(input.tags) && (input.tags as string[]).length === 2)).toBe(true)
    expect(setResourceFields).toHaveBeenCalledTimes(4)
  })

  it('keeps every room open 09:00-19:00 on all seven weekdays in Europe/Warsaw', async () => {
    const { dependencies, execute } = dependenciesFor(coreExampleState())
    await seedPolanaResources(dependencies, scope)

    const weekly = execute.mock.calls.find(([id]) => id === 'planner.availability.weekly.replace')?.[1]
    expect(weekly).toMatchObject({
      subjectType: 'ruleset',
      subjectId: 'rule-set-1',
      timezone: 'Europe/Warsaw',
    })
    expect(weekly?.windows).toEqual(POLANA_AVAILABILITY_WINDOWS)
    expect((weekly?.windows as Array<{ weekday: number }>).map((window) => window.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect((weekly?.windows as Array<{ start: string; end: string }>).every((window) => (
      window.start === '09:00' && window.end === '19:00'
    ))).toBe(true)
  })

  it('writes the shared Białowieska address onto every room', () => {
    for (const fixture of POLANA_RESOURCES) {
      const values = buildResourceCustomFieldValues(fixture)
      expect(values.polana_room_address_street).toBe('ul. Białowieska 69B')
      expect(values.polana_room_address_postal_code).toBe('54-234')
      expect(values.polana_room_address_city).toBe('Wrocław')
      expect(POLANA_ROOM_ADDRESS.country).toBe('Polska')
      expect(Object.keys(values).every(isPolanaRoomFieldKey)).toBe(true)
    }
  })

  it('is idempotent: a second run updates in place and creates nothing new', async () => {
    const { dependencies, execute } = dependenciesFor({
      resources: POLANA_RESOURCES.map((fixture, index) => ({
        id: `resource-${index}`,
        name: fixture.name,
        resourceTypeId: `type-${index}`,
      })),
      types: POLANA_RESOURCE_TYPES.map((fixture, index) => ({ id: `type-${index}`, name: fixture.name })),
      tags: POLANA_RESOURCE_TAGS.map((fixture, index) => ({ id: `tag-${index}`, slug: fixture.slug })),
      ruleSets: [{ id: 'rule-set-existing', name: 'Gabinety Polany Przygody 9:00–19:00' }],
    })

    const summary = await seedPolanaResources(dependencies, scope)

    expect(summary).toEqual({
      removedResources: 0,
      removedResourceTypes: 0,
      removedResourceTags: 0,
      createdResourceTypes: 0,
      createdResourceTags: 0,
      createdResources: 0,
      updatedResources: 4,
      availabilityRuleSetId: 'rule-set-existing',
    })
    expect(execute.mock.calls.filter(([id]) => id.endsWith('.create'))).toHaveLength(0)
    expect(execute.mock.calls.filter(([id]) => id.endsWith('.delete'))).toHaveLength(0)
  })

  it('ignores assignments left behind by the resources it just removed', async () => {
    // `resources.resources.delete` is a soft delete, so every example resource's
    // tag assignment rows survive the removal. They must not keep a tag alive.
    const state = coreExampleState()
    const { dependencies } = dependenciesFor({
      ...state,
      tagAssignments: state.resources.flatMap((resource) => state.tags.map((tag) => ({
        tagId: tag.id,
        resourceId: resource.id,
      }))),
    })

    const summary = await seedPolanaResources(dependencies, scope)

    expect(summary.removedResourceTags).toBe(6)
  })

  it('keeps a legacy tag an operator still uses on a surviving resource', async () => {
    const state = coreExampleState()
    const { dependencies, execute } = dependenciesFor({
      ...state,
      resources: [...state.resources, { id: 'own-1', name: 'Gabinet gościnny', resourceTypeId: null }],
      tagAssignments: [{ tagId: 'legacy-tag-0', resourceId: 'own-1' }],
    })

    const summary = await seedPolanaResources(dependencies, scope)

    expect(summary.removedResourceTags).toBe(5)
    expect(execute.mock.calls.filter(([id]) => id === 'resources.resourceTags.delete').map(([, input]) => input.id))
      .not.toContain('legacy-tag-0')
  })

  it('keeps a legacy type that a surviving resource still points at', async () => {
    const state = coreExampleState()
    const { dependencies } = dependenciesFor({
      ...state,
      resources: [...state.resources, { id: 'own-1', name: 'Gabinet gościnny', resourceTypeId: 'legacy-type-0' }],
    })

    const summary = await seedPolanaResources(dependencies, scope)

    expect(summary.removedResources).toBe(8)
    expect(summary.removedResourceTypes).toBe(3)
  })

  it('reports an exact zero-write dry-run plan', async () => {
    const { dependencies, execute, setResourceFields } = dependenciesFor(coreExampleState())

    const plan = await planPolanaResources(dependencies, scope)

    expect(plan.resourcesToRemove).toEqual([...LEGACY_RESOURCE_NAMES])
    expect(plan.resourceTypesToRemove).toEqual([...LEGACY_RESOURCE_TYPE_NAMES])
    expect(plan.resourceTagsToRemove).toEqual([...LEGACY_RESOURCE_TAG_SLUGS])
    expect(plan.resourcesToCreate).toEqual(POLANA_RESOURCES.map((fixture) => fixture.name))
    expect(plan.resourcesToUpdate).toEqual([])
    expect(plan.availabilityRuleSetToCreate).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    expect(setResourceFields).not.toHaveBeenCalled()
    expect(dependencies.ensureFields).not.toHaveBeenCalled()
  })

  it('refuses to run without a trusted tenant and organization', async () => {
    const { dependencies } = dependenciesFor()
    await expect(seedPolanaResources(dependencies, { tenantId: '', organizationId: scope.organizationId }))
      .rejects.toThrow('requires tenantId and organizationId')
    await expect(seedPolanaResources(dependencies, { tenantId: scope.tenantId, organizationId: '' }))
      .rejects.toThrow('requires tenantId and organizationId')
  })
})
