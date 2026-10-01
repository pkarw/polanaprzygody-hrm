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

  it('bounds the probed span so planner rule expansion cannot be driven by the caller', () => {
    const valid = {
      teamMemberId: memberId,
      startsAt: '2026-09-30T10:00:00+02:00',
      endsAt: '2026-09-30T11:00:00+02:00',
    }
    // The extended-year form parses to 8.64e15 and would expand ~1e8 daily occurrences.
    expect(patientVisitAvailabilityCheckQuerySchema.safeParse({
      ...valid,
      endsAt: '+275760-09-13T00:00:00Z',
    }).success).toBe(false)
    // A four-digit far-future year is still ~2.9e6 occurrences per rule.
    expect(patientVisitAvailabilityCheckQuerySchema.safeParse({
      ...valid,
      endsAt: '9999-12-31T23:59:59Z',
    }).success).toBe(false)
    // The probe answers "is this one slot free", so its ceiling is a day — tighter than the
    // stored-visit span. A wider window would return every unavailability overlapping it,
    // which is the schedule dump VCAL's security section forbids.
    expect(patientVisitAvailabilityCheckQuerySchema.safeParse({
      ...valid,
      startsAt: '2026-09-01T08:00:00Z',
      endsAt: '2026-09-02T08:00:00Z',
    }).success).toBe(true)
    expect(patientVisitAvailabilityCheckQuerySchema.safeParse({
      ...valid,
      startsAt: '2026-09-01T08:00:00Z',
      endsAt: '2026-09-02T08:00:01Z',
    }).success).toBe(false)
    expect(patientVisitAvailabilityCheckQuerySchema.safeParse({
      ...valid,
      startsAt: '2026-09-01T00:00:00Z',
      endsAt: '2026-09-30T00:00:00Z',
    }).success).toBe(false)
  })

  it('bounds the overlap read so one decision cannot load a whole visit history', () => {
    const source = readFileSync(
      path.join(__dirname, '..', 'lib', 'patientAvailabilityService.ts'),
      'utf8',
    )
    // Every returned row becomes an acknowledgeable `*_double_booked` conflict, so an
    // unbounded `em.find` is both a memory risk and an enumeration surface.
    expect(source).toContain('limit: PATIENT_VISIT_MAX_OVERLAP_ROWS')
  })

  it('localizes the operator-facing errors these routes render verbatim', () => {
    const calendar = readFileSync(
      path.join(__dirname, '..', 'api', 'visits', 'calendar', 'route.ts'),
      'utf8',
    )
    const availability = readFileSync(
      path.join(__dirname, '..', 'api', 'visits', 'availability-check', 'route.ts'),
      'utf8',
    )
    expect(calendar).toContain("translate(\n          'patient.errors.calendarTooManyItems'")
    expect(availability).toContain("translate(\n          'patient.errors.visitReferenceUnavailable'")
    // The machine-readable codes must survive localization.
    expect(calendar).toContain("code: 'visit_calendar_too_many_items'")
    expect(availability).toContain("code: 'visit_reference_unavailable'")
    for (const locale of ['en', 'pl'] as const) {
      const catalog = JSON.parse(readFileSync(
        path.join(__dirname, '..', 'i18n', `${locale}.json`),
        'utf8',
      )) as Record<string, string>
      for (const key of [
        'patient.errors.calendarTooManyItems',
        'patient.errors.visitReferenceUnavailable',
      ]) {
        expect(catalog[key] ?? '').not.toBe('')
      }
    }
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
