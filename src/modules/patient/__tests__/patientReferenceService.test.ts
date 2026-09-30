import { describe, expect, it, jest } from '@jest/globals'
import { createPatientReferenceService } from '../lib/patientReferenceService'

/**
 * Regression oracle for the DI wiring of `patientReferenceService`.
 *
 * The failure this pins was real and reached the running app: creating a patient with a lead
 * carer threw `TypeError: Cannot read properties of undefined (reading 'find')` from inside
 * `findWithDecryption`, several frames away from the actual mistake.
 *
 * The cause: the app container runs awilix in `InjectionMode.CLASSIC`
 * (`@open-mercato/shared/lib/di/container.ts`), which resolves dependencies by reading the
 * factory's parameter NAMES. The factory had been written as `({ em })` — a destructuring
 * pattern, which classic mode cannot match to a registration, so it injected `undefined`.
 * Nothing failed at registration time; the service constructed fine and only blew up on the
 * first query.
 *
 * Two assertions, because either alone would miss the defect:
 *
 * - The factory must ACCEPT an `em` positionally and use it. A behavioural test proves the
 *   dependency actually reaches the queries.
 * - The first parameter must be NAMED `em`. Classic mode matches on that name, so renaming it to
 *   `entityManager` would compile, pass every behavioural test, and still inject `undefined` in
 *   production. This is the only assertion that catches that.
 */
describe('createPatientReferenceService DI contract', () => {
  it('names its first parameter `em`, which is what CLASSIC injection matches on', () => {
    const source = createPatientReferenceService.toString()
    const params = source.slice(source.indexOf('(') + 1, source.indexOf(')'))
    const first = params.split(',')[0]?.trim() ?? ''
    // A destructuring pattern would start with `{` — exactly the shape that silently injected
    // undefined.
    expect(first.startsWith('{')).toBe(false)
    expect(first.replace(/:.*$/, '').trim()).toBe('em')
  })

  it('accepts the EntityManager positionally and queries through it', async () => {
    const find = jest.fn(async () => [])
    // Minimal EntityManager stand-in: `findWithDecryption` calls `em.find`, which is precisely
    // the call that threw when `em` was undefined.
    const em = { find, getMetadata: () => undefined } as never

    const service = createPatientReferenceService(em)
    const resolved = await service.resolveTeamMembers(['11111111-1111-4111-8111-111111111111'], {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })

    expect(find).toHaveBeenCalled()
    expect(resolved.size).toBe(0)
  })

  it('short-circuits without touching the EntityManager when there is nothing to resolve', async () => {
    const find = jest.fn(async () => [])
    const em = { find, getMetadata: () => undefined } as never
    const service = createPatientReferenceService(em)

    // An empty id list must not issue a query with an empty `IN ()`.
    expect((await service.resolveTeamMembers([], { tenantId: 't', organizationId: 'o' })).size).toBe(0)
    expect((await service.resolveCrmPeople([], { tenantId: 't', organizationId: 'o' })).size).toBe(0)
    expect((await service.resolveUsers([], { tenantId: 't', organizationId: 'o' })).size).toBe(0)
    expect((await service.resolveResources([], { tenantId: 't', organizationId: 'o' })).size).toBe(0)
    expect((await service.resolveProducts([], { tenantId: 't', organizationId: 'o' })).size).toBe(0)
    expect(find).not.toHaveBeenCalled()
  })

  it('refuses an unresolvable reference with 422 rather than returning a partial result', async () => {
    const em = { find: async () => [], getMetadata: () => undefined } as never
    const service = createPatientReferenceService(em)

    await expect(
      service.requireActiveTeamMember('11111111-1111-4111-8111-111111111111', {
        tenantId: 't',
        organizationId: 'o',
      }),
    ).rejects.toMatchObject({ status: 422 })

    await expect(
      service.requireActiveCrmPerson('11111111-1111-4111-8111-111111111111', {
        tenantId: 't',
        organizationId: 'o',
      }),
    ).rejects.toMatchObject({ status: 422 })

    await expect(
      service.requireActiveResource('11111111-1111-4111-8111-111111111111', {
        tenantId: 't',
        organizationId: 'o',
      }),
    ).rejects.toMatchObject({ status: 422 })

    await expect(
      service.requireActiveProducts(['11111111-1111-4111-8111-111111111111'], {
        tenantId: 't',
        organizationId: 'o',
      }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it('returns product snapshots in request order and rejects any inactive member', async () => {
    const rows = [
      { id: 'product-b', title: 'Consultation', sku: null, isActive: true, deletedAt: null },
      { id: 'product-a', title: 'Examination', sku: 'EXAM', isActive: true, deletedAt: null },
    ]
    const em = { find: async () => rows, getMetadata: () => undefined } as never
    const service = createPatientReferenceService(em)

    await expect(
      service.requireActiveProducts(['product-a', 'product-b'], { tenantId: 't', organizationId: 'o' }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'product-a', displayName: 'Examination', sku: 'EXAM' }),
      expect.objectContaining({ id: 'product-b', displayName: 'Consultation', sku: null }),
    ])

    rows[1].isActive = false
    await expect(
      service.requireActiveProducts(['product-a', 'product-b'], { tenantId: 't', organizationId: 'o' }),
    ).rejects.toMatchObject({ status: 422 })
  })
})
