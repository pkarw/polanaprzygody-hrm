import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { patientVisitAvailabilityCheckQuerySchema } from '../data/validators'
import { patientVisitAvailabilityCheckResponseSchema } from '../api/openapi'

const memberId = '11111111-1111-4111-8111-111111111111'

describe('visit availability-check route', () => {
  it('requires visit management and documents a GET-only public contract', () => {
    const source = readFileSync(
      path.join(__dirname, '..', 'api', 'visits', 'availability-check', 'route.ts'),
      'utf8',
    )
    expect(source).toContain("GET: { requireAuth: true, requireFeatures: ['patient.visits.manage'] }")
    expect(source).toContain('query: patientVisitAvailabilityCheckQuerySchema')
    for (const status of [200, 400, 401, 403, 422, 503]) {
      expect(source).toContain(`status: ${status}`)
    }
  })

  it('validates explicit-offset instants and half-open intervals', () => {
    const valid = {
      teamMemberId: memberId,
      startsAt: '2026-09-30T10:00:00+02:00',
      endsAt: '2026-09-30T11:00:00+02:00',
    }
    expect(patientVisitAvailabilityCheckQuerySchema.safeParse(valid).success).toBe(true)
    expect(patientVisitAvailabilityCheckQuerySchema.safeParse({ ...valid, startsAt: '2026-09-30T10:00:00' }).success).toBe(false)
    expect(patientVisitAvailabilityCheckQuerySchema.safeParse({ ...valid, endsAt: valid.startsAt }).success).toBe(false)
    expect(patientVisitAvailabilityCheckQuerySchema.safeParse({ ...valid, tenantId: memberId }).success).toBe(false)
  })

  it('publishes stable conflict enums without making private reasons mandatory', () => {
    const result = patientVisitAvailabilityCheckResponseSchema.safeParse({
      conflicts: [{
        code: 'member_double_booked',
        severity: 'warning',
        subjectType: 'member',
        subjectId: memberId,
        subjectName: 'Anna Nowicka',
        from: '2026-09-30T10:00:00.000Z',
        to: '2026-09-30T11:00:00.000Z',
        conflictingVisitId: '22222222-2222-4222-8222-222222222222',
        signature: 'a'.repeat(64),
      }],
      worstSeverity: 'warning',
      checkedAt: '2026-09-30T09:59:00.000Z',
    })
    expect(result.success).toBe(true)
  })

  it('uses trusted route scope and omits reason labels unless host ACL passes', () => {
    const source = readFileSync(
      path.join(__dirname, '..', 'api', 'visits', 'availability-check', 'route.ts'),
      'utf8',
    )
    expect(source).toContain('ctx.selectedOrganizationId ?? ctx.auth?.orgId')
    expect(source).toContain("canViewHostReason(ctx, scope, 'staff.view')")
    expect(source).toContain("canViewHostReason(ctx, scope, 'resources.view')")
    expect(source).toContain('redactVisitConflictsForRead(')
    expect(source).not.toContain('tenantId: parsed')
    expect(source).not.toContain('organizationId: parsed')
  })
})
