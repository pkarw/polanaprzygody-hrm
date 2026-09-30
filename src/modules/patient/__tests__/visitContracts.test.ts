import { describe, expect, it } from '@jest/globals'
import {
  patientVisitCreateSchema,
  patientVisitListQuerySchema,
  patientVisitUpdateSchema,
} from '../data/validators'
import { features } from '../acl'
import { defaultEncryptionMaps } from '../encryption'
import { eventsConfig, type PatientEventId } from '../events'

const uuid = (n: number) => `${String(n).repeat(8)}-aaaa-4bbb-8ccc-dddddddddddd`

const createInput = {
  patientId: uuid(1),
  teamMemberId: uuid(2),
  startsAt: '2026-10-05T10:00:00+02:00',
  endsAt: '2026-10-05T11:00:00+02:00',
  timeZone: 'Europe/Warsaw',
  clientRequestId: uuid(3),
}

describe('patient visit contracts', () => {
  it('accepts a visit with no services and normalizes the default list', () => {
    expect(patientVisitCreateSchema.parse(createInput).serviceProductIds).toEqual([])
  })

  it('accepts one or many unique services and rejects duplicates', () => {
    expect(patientVisitCreateSchema.safeParse({ ...createInput, serviceProductIds: [uuid(4), uuid(5)] }).success).toBe(true)
    expect(patientVisitCreateSchema.safeParse({ ...createInput, serviceProductIds: [uuid(4), uuid(4)] }).success).toBe(false)
  })

  it('requires an explicit offset, valid IANA zone, and a later end', () => {
    expect(patientVisitCreateSchema.safeParse({ ...createInput, startsAt: '2026-10-05T10:00:00' }).success).toBe(false)
    expect(patientVisitCreateSchema.safeParse({ ...createInput, timeZone: 'Warsaw' }).success).toBe(false)
    expect(patientVisitCreateSchema.safeParse({ ...createInput, endsAt: createInput.startsAt }).success).toBe(false)
    expect(patientVisitCreateSchema.safeParse({
      ...createInput,
      startsAt: '2026-10-05T08:00:00Z',
      endsAt: '2026-10-05T09:00:00Z',
      timeZone: 'GMT',
    }).success).toBe(true)
    expect(patientVisitCreateSchema.safeParse({
      ...createInput,
      startsAt: '2026-03-29T02:30:00+01:00',
      endsAt: null,
    }).success).toBe(false)
    expect(patientVisitCreateSchema.safeParse({
      ...createInput,
      startsAt: '2026-10-25T02:30:00+02:00',
      endsAt: null,
    }).success).toBe(true)
    expect(patientVisitCreateSchema.safeParse({
      ...createInput,
      startsAt: '2026-10-25T02:30:00+01:00',
      endsAt: null,
    }).success).toBe(true)
  })

  it('keeps omitted services distinct from an explicit empty update', () => {
    const base = { id: uuid(1), expectedUpdatedAt: '2026-09-30T09:00:00.000Z' }
    expect('serviceProductIds' in patientVisitUpdateSchema.parse(base)).toBe(false)
    expect(patientVisitUpdateSchema.parse({ ...base, serviceProductIds: [] }).serviceProductIds).toEqual([])
    expect(patientVisitUpdateSchema.safeParse({ ...base, serviceProductIds: null }).success).toBe(false)
  })

  it('rejects lifecycle, actor, and scope fields on generic writes', () => {
    expect(patientVisitCreateSchema.safeParse({ ...createInput, tenantId: uuid(7) }).success).toBe(false)
    expect(patientVisitUpdateSchema.safeParse({ id: uuid(1), expectedUpdatedAt: 'v', status: 'completed' }).success).toBe(false)
    expect(patientVisitUpdateSchema.safeParse({ id: uuid(1), expectedUpdatedAt: 'v', isSettled: true }).success).toBe(false)
  })

  it('validates half-open list ranges', () => {
    expect(patientVisitListQuerySchema.safeParse({ from: '2026-10-05T10:00:00Z', to: '2026-10-05T11:00:00Z' }).success).toBe(true)
    expect(patientVisitListQuerySchema.safeParse({ from: '2026-10-05T11:00:00Z', to: '2026-10-05T10:00:00Z' }).success).toBe(false)
  })

  it('declares the complete feature dependency chain', () => {
    const byId = new Map(features.map((feature) => [feature.id, feature]))
    expect(byId.get('patient.visits.view')?.dependsOn).toEqual(['patient.patients.view'])
    expect(byId.get('patient.visits.manage')?.dependsOn).toEqual(['patient.visits.view'])
    expect(byId.get('patient.visits.settle')?.dependsOn).toEqual(['patient.visits.view'])
    expect(byId.get('patient.visits.correct')?.dependsOn).toEqual(['patient.visits.manage'])
  })

  it('encrypts visit free text and historical person/service snapshots', () => {
    const maps = new Map(defaultEncryptionMaps.map((map) => [map.entityId, map.fields.map((field) => field.field)]))
    expect(maps.get('patient:patient_visit')).toEqual(expect.arrayContaining([
      'team_member_name_snapshot',
      'resource_name_snapshot',
      'description',
      'status_reason',
      'settlement_reason',
      'create_request_payload',
    ]))
    expect(maps.get('patient:patient_visit_service')).toEqual([
      'product_title_snapshot',
      'product_sku_snapshot',
    ])
  })

  it('keeps all VIS event IDs typed and stable', () => {
    const ids: PatientEventId[] = [
      'patient.visit.created',
      'patient.visit.updated',
      'patient.visit.deleted',
      'patient.visit.confirmed',
      'patient.visit.unconfirmed',
      'patient.visit.status_changed',
      'patient.visit.settlement_changed',
    ]
    expect(ids).toHaveLength(7)

    const byId = new Map(eventsConfig.events.map((event) => [event.id, event]))
    for (const id of ids) {
      expect(byId.get(id)?.payloadSchema?.fields.map((field) => field.path)).toEqual(
        expect.arrayContaining(['id', 'patientId', 'tenantId', 'organizationId', 'updatedAt']),
      )
    }
    expect(byId.get('patient.visit.status_changed')?.payloadSchema?.fields).toContainEqual({ path: 'status', type: 'text' })
    expect(byId.get('patient.visit.settlement_changed')?.payloadSchema?.fields).toContainEqual({ path: 'isSettled', type: 'boolean' })
  })
})
