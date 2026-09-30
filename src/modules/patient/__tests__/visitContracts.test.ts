import { describe, expect, it } from '@jest/globals'
import {
  patientVisitCreateSchema,
  patientVisitConfirmationActionSchema,
  patientVisitConfirmationRequestSchema,
  patientVisitListQuerySchema,
  patientVisitSettlementRequestSchema,
  patientVisitSettleSchema,
  patientVisitStatusRequestSchema,
  patientVisitTransitionSchema,
  patientVisitUnsettleSchema,
  patientVisitUpdateSchema,
} from '../data/validators'
import { features } from '../acl'
import { defaultEncryptionMaps } from '../encryption'
import { eventsConfig, type PatientEventId } from '../events'
import { defaultEncryptionMaps as auditLogEncryptionMaps } from '@open-mercato/core/modules/audit_logs/encryption'

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

  it('keeps service arrays structurally valid so commands can map duplicates to 409', () => {
    expect(patientVisitCreateSchema.safeParse({ ...createInput, serviceProductIds: [uuid(4), uuid(5)] }).success).toBe(true)
    expect(patientVisitCreateSchema.safeParse({ ...createInput, serviceProductIds: [uuid(4), uuid(4)] }).success).toBe(true)
  })

  it('keeps syntax errors at 400 while commands map semantic time failures to 422', () => {
    expect(patientVisitCreateSchema.safeParse({ ...createInput, startsAt: '2026-10-05T10:00:00' }).success).toBe(false)
    expect(patientVisitCreateSchema.safeParse({ ...createInput, timeZone: 'Warsaw' }).success).toBe(false)
    expect(patientVisitCreateSchema.safeParse({ ...createInput, endsAt: createInput.startsAt }).success).toBe(true)
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
    }).success).toBe(true)
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

  it('keeps lifecycle payloads strict and requires reasons only for destructive corrections', () => {
    const versioned = { id: uuid(1), expectedUpdatedAt: '2026-09-30T09:00:00.000Z' }
    expect(patientVisitConfirmationActionSchema.safeParse(versioned).success).toBe(true)
    expect(patientVisitConfirmationActionSchema.safeParse({ ...versioned, confirmed: true }).success).toBe(false)
    expect(patientVisitTransitionSchema.safeParse({ ...versioned, status: 'completed' }).success).toBe(true)
    expect(patientVisitTransitionSchema.safeParse({ ...versioned, status: 'completed', reason: 'extra' }).success).toBe(false)
    for (const status of ['planned', 'cancelled', 'no_show'] as const) {
      expect(patientVisitTransitionSchema.safeParse({ ...versioned, status }).success).toBe(false)
      expect(patientVisitTransitionSchema.safeParse({ ...versioned, status, reason: 'Operator reason' }).success).toBe(true)
    }
    expect(patientVisitSettleSchema.safeParse(versioned).success).toBe(true)
    expect(patientVisitSettleSchema.safeParse({ ...versioned, reason: 'Advance recorded' }).success).toBe(true)
    expect(patientVisitUnsettleSchema.safeParse(versioned).success).toBe(false)
    expect(patientVisitUnsettleSchema.safeParse({ ...versioned, reason: 'Correction' }).success).toBe(true)
  })

  it('validates action-route intent without accepting path, scope, or actor fields', () => {
    const version = { expectedUpdatedAt: '2026-09-30T09:00:00.000Z' }
    expect(patientVisitConfirmationRequestSchema.safeParse({ ...version, confirmed: true }).success).toBe(true)
    expect(patientVisitConfirmationRequestSchema.safeParse({ ...version, confirmed: true, id: uuid(1) }).success).toBe(false)
    expect(patientVisitStatusRequestSchema.safeParse({ ...version, status: 'cancelled', reason: 'Operator decision' }).success).toBe(true)
    expect(patientVisitStatusRequestSchema.safeParse({ ...version, status: 'cancelled' }).success).toBe(false)
    expect(patientVisitSettlementRequestSchema.safeParse({ ...version, isSettled: true }).success).toBe(true)
    expect(patientVisitSettlementRequestSchema.safeParse({ ...version, isSettled: false }).success).toBe(false)
    expect(patientVisitSettlementRequestSchema.safeParse({ ...version, isSettled: false, reason: 'Correction' }).success).toBe(true)
    for (const forbiddenKey of ['tenantId', 'organizationId', 'actorId', 'userId']) {
      expect(patientVisitConfirmationRequestSchema.safeParse({
        ...version,
        confirmed: true,
        [forbiddenKey]: uuid(9),
      }).success).toBe(false)
    }
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

  it('relies on the installed audit-log contract to encrypt command payloads and snapshots', () => {
    const actionLog = auditLogEncryptionMaps.find((map) => map.entityId === 'audit_logs:action_log')
    expect(actionLog?.fields.map((field) => field.field)).toEqual(expect.arrayContaining([
      'command_payload',
      'snapshot_before',
      'snapshot_after',
      'changes_json',
      'context_json',
    ]))
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
