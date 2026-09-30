import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'
import { patientVisitListQuerySchema } from '../data/validators'
import {
  patientVisitCreatedSchema,
  patientVisitDeletedResultSchema,
  patientVisitListItemSchema,
  patientVisitVersionedResultSchema,
} from '../api/openapi'

const visitsRouteSource = readFileSync(path.join(__dirname, '..', 'api', 'visits', 'route.ts'), 'utf8')

const uuid = (n: number) => `${String(n).repeat(8)}-aaaa-4bbb-8ccc-dddddddddddd`

describe('patient visit API contracts', () => {
  it('accepts the documented filters and rejects arbitrary sort columns', () => {
    const parsed = patientVisitListQuerySchema.parse({
      patientId: uuid(1),
      teamMemberId: uuid(2),
      resourceId: uuid(3),
      status: 'planned',
      isSettled: 'false',
      from: '2026-10-05T08:00:00Z',
      to: '2026-10-06T08:00:00Z',
      sortField: 'startsAt',
      sortDir: 'desc',
    })
    expect(parsed.page).toBe(1)
    expect(parsed.pageSize).toBe(25)
    expect(patientVisitListQuerySchema.safeParse({ sortField: 'description' }).success).toBe(false)
  })

  it('documents the detail-only description as optional and replay-safe mutation responses', () => {
    const listItem = patientVisitListItemSchema.parse({
      id: uuid(1),
      patientId: uuid(2),
      patientName: 'Jan Kowalski',
      teamMemberId: uuid(3),
      teamMemberName: 'Anna Nowak',
      resourceId: null,
      resourceName: null,
      startsAt: '2026-10-05T08:00:00.000Z',
      endsAt: null,
      timeZone: 'Europe/Warsaw',
      status: 'planned',
      confirmedAt: null,
      isConfirmed: false,
      confirmationApplicable: true,
      isSettled: false,
      settledAt: null,
      services: [],
      updatedAt: '2026-10-05T09:00:00.000Z',
      description: 'documented only when the runtime detail lookup supplies it',
    })
    expect(listItem.description).toBe('documented only when the runtime detail lookup supplies it')
    expect(patientVisitCreatedSchema.safeParse({
      id: uuid(1),
      status: 'completed',
      confirmedAt: '2026-10-05T08:00:00.000Z',
      isSettled: true,
      updatedAt: '2026-10-05T09:00:00.000Z',
    }).success).toBe(true)
    expect(patientVisitVersionedResultSchema.safeParse({
      ok: true,
      id: uuid(1),
      updatedAt: '2026-10-05T09:00:00.000Z',
    }).success).toBe(true)
    expect(patientVisitDeletedResultSchema.safeParse({
      ok: true,
      id: uuid(1),
      updatedAt: '2026-10-05T09:00:00.000Z',
      deleted: true,
    }).success).toBe(true)
  })

  it('pins scoped half-open filters, bounded enrichment, and stable pagination in the route', () => {
    expect(visitsRouteSource).toContain("requireFeatures: ['patient.visits.view', 'patient.patients.view']")
    expect(visitsRouteSource).toContain("F.starts_at = {")
    expect(visitsRouteSource).toContain("...(q.to ? { $lt: new Date(q.to) } : {})")
    expect(visitsRouteSource).toContain("defaultSort: { field: starts_at, dir: 'asc' }")
    expect(visitsRouteSource).toContain('tiebreakSortField: idField')
    expect(visitsRouteSource.match(/findWithDecryption\(/g)).toHaveLength(2)
    expect(visitsRouteSource).toContain('PatientVisitService')
    expect(visitsRouteSource).toContain('descriptionField')
    expect(visitsRouteSource).toContain('isVisitDetailQuery(query)')
  })

  it('delegates patient-list enrichment to the executable next-visit helper', () => {
    const patientsRouteSource = readFileSync(path.join(__dirname, '..', 'api', 'patients', 'route.ts'), 'utf8')
    expect(patientsRouteSource).toContain('await enrichPatientNextVisits(items, ctx)')
  })
})
