import { expect, test } from '@playwright/test'
import {
  createOrganizationFixture,
  createUserFixture,
  deleteOrganizationIfExists,
  deleteUserIfExists,
  setUserAclVisibility,
} from '@open-mercato/core/helpers/integration/authFixtures'
import {
  createProductFixture,
  deleteCatalogProductIfExists,
} from '@open-mercato/core/helpers/integration/catalogFixtures'
import {
  createStaffTeamMemberFixture,
  deleteStaffEntityIfExists,
} from '@open-mercato/core/helpers/integration/staffFixtures'
import {
  callApi,
  callApiOk,
  cleanupPatient,
  cleanupVisit,
  createPatient,
  createVisit,
  login,
  newRequestId,
  readPatient,
  readVisit,
  unique,
  type CreatedPatient,
  type ScopedActor,
} from './helpers/api'

const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999'

function actorScope(actor: ScopedActor): { tenantId: string; organizationId: string } {
  const encoded = actor.token.split('.')[1]
  if (!encoded) throw new Error('Authenticated fixture token has no JWT payload')
  const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
    tenantId?: unknown
    orgId?: unknown
  }
  if (typeof claims.tenantId !== 'string' || typeof claims.orgId !== 'string') {
    throw new Error('Authenticated fixture token has no tenant/organization scope')
  }
  return { tenantId: claims.tenantId, organizationId: claims.orgId }
}

test.describe('VIS-T02: scoped references and historical snapshots', () => {
  test('refuses user ids, inactive products, and unknown references while retaining snapshots', async ({ request }) => {
    const actor = await login(request)
    const { organizationId } = actorScope(actor)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let productId: string | null = null
    let visitId: string | null = null
    let userId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS snapshot clinician'),
      })
      productId = await createProductFixture(request, actor.token, {
        title: unique('VIS historical service'),
        sku: unique('VIS-HISTORY'),
      })
      userId = await createUserFixture(request, actor.token, {
        email: `${unique('vis-auth-user')}@example.test`,
        name: 'Auth user is not a staff member',
        password: 'Visit-Test-42!',
        organizationId,
        roles: [],
      })

      const userInsteadOfMember = await callApi(request, 'POST', '/api/patient/visits', actor, {
        patientId: patient.id,
        teamMemberId: userId,
        startsAt: '2026-11-04T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        clientRequestId: newRequestId(),
      })
      expect(userInsteadOfMember.status).toBe(422)

      const unknownResource = await callApi(request, 'POST', '/api/patient/visits', actor, {
        patientId: patient.id,
        teamMemberId,
        resourceId: UNKNOWN_UUID,
        startsAt: '2026-11-04T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        clientRequestId: newRequestId(),
      })
      expect(unknownResource.status).toBe(422)

      const created = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        resourceId: null,
        startsAt: '2026-11-04T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        serviceProductIds: [productId],
      })
      visitId = created.id
      const beforeRemoval = await readVisit(request, actor, visitId)
      expect(beforeRemoval).toMatchObject({ resourceId: null })
      expect(beforeRemoval?.services).toHaveLength(1)
      const historicalTitle = beforeRemoval?.services[0]?.title
      expect(historicalTitle).toBeTruthy()

      await callApiOk(request, 'PUT', '/api/catalog/products', actor, {
        id: productId,
        isActive: false,
      })
      const inactiveCreate = await callApi(request, 'POST', '/api/patient/visits', actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2026-11-04T11:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        serviceProductIds: [productId],
        clientRequestId: newRequestId(),
      })
      expect(inactiveCreate.status).toBe(422)

      const invalidAddition = await callApi(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: beforeRemoval?.updatedAt,
        serviceProductIds: [productId, UNKNOWN_UUID],
      })
      expect(invalidAddition.status).toBe(422)

      const removedProductId = productId
      const removal = await callApi(
        request,
        'DELETE',
        `/api/catalog/products?id=${encodeURIComponent(removedProductId)}`,
        actor,
      )
      expect(removal.status).toBeGreaterThanOrEqual(200)
      expect(removal.status).toBeLessThan(300)
      const removedLookup = await callApi<{ items?: Array<{ id?: string }> }>(
        request,
        'GET',
        `/api/catalog/products?id=${encodeURIComponent(removedProductId)}&pageSize=1&withDeleted=false`,
        actor,
      )
      expect(removedLookup.status).toBe(200)
      expect(removedLookup.body.items ?? []).toEqual([])
      productId = null
      const afterRemoval = await readVisit(request, actor, visitId)
      expect(afterRemoval?.services[0]?.title).toBe(historicalTitle)
      expect(afterRemoval?.services[0]?.productId).toBe(beforeRemoval?.services[0]?.productId)
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteCatalogProductIfExists(request, actor.token, productId)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
      await deleteUserIfExists(request, actor.token, userId)
    }
  })
})

test.describe('VIS-T03: atomic service edits', () => {
  test('distinguishes omitted, empty, duplicate, invalid, and stale service writes', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let firstProductId: string | null = null
    let secondProductId: string | null = null
    let visitId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS atomic clinician'),
      })
      firstProductId = await createProductFixture(request, actor.token, {
        title: unique('VIS atomic first'),
        sku: unique('VIS-ATOM-A'),
      })
      secondProductId = await createProductFixture(request, actor.token, {
        title: unique('VIS atomic second'),
        sku: unique('VIS-ATOM-B'),
      })
      const created = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2026-11-07T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        serviceProductIds: [firstProductId, secondProductId],
      })
      visitId = created.id

      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: created.updatedAt,
        description: 'Header-only update leaves services alone',
      })
      const headerOnly = await readVisit(request, actor, visitId)
      expect(headerOnly?.services.map((service) => service.productId))
        .toEqual([firstProductId, secondProductId])

      const duplicate = await callApi(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: headerOnly?.updatedAt,
        serviceProductIds: [firstProductId, firstProductId],
      })
      expect(duplicate.status).toBe(409)
      expect(duplicate.body).toMatchObject({ code: 'visit_service_duplicate' })

      const invalidMiddle = await callApi(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: headerOnly?.updatedAt,
        serviceProductIds: [secondProductId, UNKNOWN_UUID, firstProductId],
      })
      expect(invalidMiddle.status).toBe(422)
      expect((await readVisit(request, actor, visitId))?.services.map((service) => service.productId))
        .toEqual([firstProductId, secondProductId])

      await callApiOk(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: headerOnly?.updatedAt,
        serviceProductIds: [],
      })
      const cleared = await readVisit(request, actor, visitId)
      expect(cleared?.services).toEqual([])

      const stale = await callApi(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: headerOnly?.updatedAt,
        serviceProductIds: [firstProductId],
      })
      expect(stale.status).toBe(409)
      expect((await readVisit(request, actor, visitId))?.services).toEqual([])

      const explicitNull = await callApi(request, 'PUT', '/api/patient/visits', actor, {
        id: visitId,
        expectedUpdatedAt: cleared?.updatedAt,
        serviceProductIds: null,
      })
      expect(explicitNull.status).toBe(400)
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteCatalogProductIfExists(request, actor.token, secondProductId)
      await deleteCatalogProductIfExists(request, actor.token, firstProductId)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })
})

test.describe('VIS-T06: concurrency, retry, and patient archive serialization', () => {
  test('allows exactly one write per version and keeps create retries singular', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let visitId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS concurrent clinician'),
      })
      const input = {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2020-01-20T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        clientRequestId: newRequestId(),
      }
      const [firstCreate, retriedCreate] = await Promise.all([
        callApi<{ id: string; updatedAt: string }>(request, 'POST', '/api/patient/visits', actor, input),
        callApi<{ id: string; updatedAt: string }>(request, 'POST', '/api/patient/visits', actor, input),
      ])
      expect([firstCreate.status, retriedCreate.status].every((status) => status >= 200 && status < 300))
        .toBe(true)
      expect(firstCreate.body.id).toBe(retriedCreate.body.id)
      visitId = firstCreate.body.id
      const original = await readVisit(request, actor, visitId)

      const [confirmation, description] = await Promise.all([
        callApi(request, 'POST', `/api/patient/visits/${visitId}/confirmation`, actor, {
          confirmed: true,
          expectedUpdatedAt: original?.updatedAt,
        }),
        callApi(request, 'PUT', '/api/patient/visits', actor, {
          id: visitId,
          description: 'Concurrent tab update',
          expectedUpdatedAt: original?.updatedAt,
        }),
      ])
      expect([confirmation.status, description.status].sort()).toEqual([200, 409])
      const afterRace = await readVisit(request, actor, visitId)
      expect(afterRace?.updatedAt).not.toBe(original?.updatedAt)

      const staleSettlement = await callApi(
        request,
        'POST',
        `/api/patient/visits/${visitId}/settlement`,
        actor,
        { isSettled: true, expectedUpdatedAt: original?.updatedAt },
      )
      expect(staleSettlement.status).toBe(409)
      expect((await readVisit(request, actor, visitId))?.isSettled).toBe(false)

      const patientBeforeArchive = await readPatient(request, actor, patient.id)
      const blockedArchive = await callApi(
        request,
        'POST',
        `/api/patient/patients/${patient.id}/archive`,
        actor,
        { archived: true, expectedUpdatedAt: patientBeforeArchive?.updatedAt },
      )
      expect(blockedArchive.status).toBe(409)
      expect(blockedArchive.body).toMatchObject({ code: 'patient_has_planned_visits' })
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })

  test('serializes a create-versus-archive race around the patient lock', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let visitId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS archive race clinician'),
      })
      const patientRecord = await readPatient(request, actor, patient.id)
      const [created, archived] = await Promise.all([
        callApi<{ id?: string }>(request, 'POST', '/api/patient/visits', actor, {
          patientId: patient.id,
          teamMemberId,
          startsAt: '2026-11-08T10:00:00+01:00',
          timeZone: 'Europe/Warsaw',
          clientRequestId: newRequestId(),
        }),
        callApi(request, 'POST', `/api/patient/patients/${patient.id}/archive`, actor, {
          archived: true,
          expectedUpdatedAt: patientRecord?.updatedAt,
        }),
      ])
      expect([created.status, archived.status].filter((status) => status >= 200 && status < 300))
        .toHaveLength(1)
      expect([created.status, archived.status].filter((status) => status === 409))
        .toHaveLength(1)
      visitId = typeof created.body.id === 'string' ? created.body.id : null

      const finalPatient = await readPatient(request, actor, patient.id)
      const finalVisit = visitId ? await readVisit(request, actor, visitId) : null
      expect(finalPatient?.status === 'archived' ? finalVisit === null : finalVisit?.status === 'planned')
        .toBe(true)
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })
})

test.describe('VIS-T07: explicit instants and DST boundaries', () => {
  test('accepts valid UTC and fold offsets, and rejects gaps, offset mismatches, and reversed ranges', async ({ request }) => {
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    const visitIds: string[] = []
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS time clinician'),
      })
      for (const startsAt of ['2026-12-01T12:00:00Z', '2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00']) {
        const created = await createVisit(request, actor, {
          patientId: patient.id,
          teamMemberId,
          startsAt,
          timeZone: startsAt.endsWith('Z') ? 'UTC' : 'Europe/Warsaw',
        })
        visitIds.push(created.id)
        expect((await readVisit(request, actor, created.id))?.startsAt).toBeTruthy()
      }

      const rejectedCreates = [
        [{ startsAt: '2026-03-29T02:30:00+01:00', timeZone: 'Europe/Warsaw' }, 'visit_time_zone_mismatch'],
        [{ startsAt: '2026-07-10T10:00:00+01:00', timeZone: 'Europe/Warsaw' }, 'visit_time_zone_mismatch'],
        [{
          startsAt: '2026-07-10T10:00:00+02:00',
          endsAt: '2026-07-10T09:59:00+02:00',
          timeZone: 'Europe/Warsaw',
        }, 'visit_end_not_after_start'],
      ] as const
      for (const [payload, code] of rejectedCreates) {
        const refused = await callApi(request, 'POST', '/api/patient/visits', actor, {
          patientId: patient.id,
          teamMemberId,
          ...payload,
          clientRequestId: newRequestId(),
        })
        expect(refused.status).toBe(422)
        expect(refused.body).toMatchObject({ code })
      }

      const editable = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2099-07-10T10:00:00+02:00',
        endsAt: '2099-07-10T11:00:00+02:00',
        timeZone: 'Europe/Warsaw',
      })
      visitIds.push(editable.id)
      const editableRecord = await readVisit(request, actor, editable.id)
      expect(editableRecord?.startsAt).toBeTruthy()
      for (const [changes, code] of [
        [{ startsAt: '2099-07-10T10:00:00+01:00' }, 'visit_time_zone_mismatch'],
        [{ endsAt: '2099-07-10T09:59:00+02:00' }, 'visit_end_not_after_start'],
      ] as const) {
        const refused = await callApi(request, 'PUT', '/api/patient/visits', actor, {
          id: editable.id,
          expectedUpdatedAt: editable.updatedAt,
          ...changes,
        })
        expect(refused.status).toBe(422)
        expect(refused.body).toMatchObject({ code })
      }

      const zoneOnly = await callApi<{ startsAt?: string; timeZone?: string }>(
        request,
        'PUT',
        '/api/patient/visits',
        actor,
        {
          id: editable.id,
          expectedUpdatedAt: editable.updatedAt,
          timeZone: 'UTC',
        },
      )
      expect(zoneOnly.status).toBe(200)
      expect(zoneOnly.body).toMatchObject({ timeZone: 'UTC', startsAt: editableRecord?.startsAt })
    } finally {
      for (const id of visitIds) await cleanupVisit(request, actor, id)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
    }
  })
})

test.describe('VIS-T09: authentication, scope, and privacy denials', () => {
  test('fails closed without authentication and hides a visit in another selected organization', async ({ request }) => {
    const actor = await login(request)
    const { tenantId } = actorScope(actor)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let visitId: string | null = null
    let organizationId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS scoped clinician'),
      })
      const created = await createVisit(request, actor, {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2026-11-09T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        description: 'Sensitive visit text must never appear in an error or event',
      })
      visitId = created.id

      for (const [method, path, data] of [
        ['GET', `/api/patient/visits?id=${visitId}`, undefined],
        ['POST', `/api/patient/visits/${visitId}/confirmation`, {
          confirmed: true,
          expectedUpdatedAt: created.updatedAt,
        }],
      ] as const) {
        const refused = await callApi(request, method, path, null, data)
        expect(refused.status).toBe(401)
        expect(JSON.stringify(refused.body)).not.toContain('Sensitive visit text')
      }

      organizationId = await createOrganizationFixture(request, actor.token, {
        name: unique('VIS foreign organization'),
        tenantId,
      })
      const foreignScopeActor: ScopedActor = {
        token: actor.token,
        headers: {
          ...actor.headers,
          cookie: `om_selected_org=${organizationId}`,
        },
      }
      const invisible = await callApi<{ items?: unknown[] }>(
        request,
        'GET',
        `/api/patient/visits?id=${visitId}&pageSize=1`,
        foreignScopeActor,
      )
      expect(invisible.status).toBe(200)
      expect(invisible.body.items ?? []).toEqual([])

      const foreignMutation = await callApi(
        request,
        'POST',
        `/api/patient/visits/${visitId}/confirmation`,
        foreignScopeActor,
        { confirmed: true, expectedUpdatedAt: created.updatedAt },
      )
      expect(foreignMutation.status).toBe(404)
      expect((await readVisit(request, actor, visitId))?.isConfirmed).toBe(false)
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
      await deleteOrganizationIfExists(request, actor.token, organizationId)
    }
  })

  test('rechecks current host feature access before an idempotent replay', async ({ request }) => {
    const actor = await login(request)
    const { organizationId } = actorScope(actor)
    let patient: CreatedPatient | null = null
    let teamMemberId: string | null = null
    let visitId: string | null = null
    let limitedUserId: string | null = null
    try {
      patient = await createPatient(request, actor)
      teamMemberId = await createStaffTeamMemberFixture(request, actor.token, {
        displayName: unique('VIS replay clinician'),
      })
      const input = {
        patientId: patient.id,
        teamMemberId,
        startsAt: '2026-11-10T10:00:00+01:00',
        timeZone: 'Europe/Warsaw',
        serviceProductIds: [],
        clientRequestId: newRequestId(),
      }
      const created = await createVisit(request, actor, input)
      visitId = created.id

      const email = `${unique('vis-replay-limited')}@example.test`
      const password = 'Visit-Test-42!'
      limitedUserId = await createUserFixture(request, actor.token, {
        email,
        name: 'VIS retry actor without staff visibility',
        password,
        organizationId,
        roles: [],
      })
      await setUserAclVisibility(request, actor.token, {
        userId: limitedUserId,
        organizations: [organizationId],
        features: ['patient.patients.view', 'patient.visits.view', 'patient.visits.manage'],
      })
      const limitedActor = await login(request, { email, password })
      const replay = await callApi(request, 'POST', '/api/patient/visits', limitedActor, input)
      expect(replay.status).toBe(403)
      expect((await readVisit(request, actor, visitId))?.id).toBe(visitId)
    } finally {
      await cleanupVisit(request, actor, visitId)
      await cleanupPatient(request, actor, patient?.id ?? null)
      await deleteStaffEntityIfExists(request, actor.token, '/api/staff/team-members', teamMemberId)
      await deleteUserIfExists(request, actor.token, limitedUserId)
    }
  })
})
