import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'

const visitsSource = readFileSync(path.join(__dirname, '..', 'commands', 'visits.ts'), 'utf8')
const patientsSource = readFileSync(path.join(__dirname, '..', 'commands', 'patients.ts'), 'utf8')

describe('visit command invariants', () => {
  it('registers aggregate CRUD and explicit lifecycle commands', () => {
    expect(visitsSource).toContain("id: 'patient.visits.create'")
    expect(visitsSource).toContain("id: 'patient.visits.update'")
    expect(visitsSource).toContain("id: 'patient.visits.delete'")
    for (const id of [
      'patient.visits.confirm',
      'patient.visits.unconfirm',
      'patient.visits.transition',
      'patient.visits.settle',
      'patient.visits.unsettle',
      'patient.visits.ensurePaymentLink',
      'patient.visits.sendPaymentLinkEmail',
    ]) expect(visitsSource).toContain(`id: '${id}'`)
    expect(visitsSource.match(/registerCommand\(/g)).toHaveLength(10)
    expect(visitsSource.match(/isUndoable: true/g)).toHaveLength(3)
    expect(visitsSource).toContain('isUndoable: false')
  })

  it('uses the parent-first lock order and compares visit versions under that transaction', () => {
    const updateStart = visitsSource.indexOf('const updateVisitCommand')
    const deleteStart = visitsSource.indexOf('const deleteVisitCommand')
    const updateBody = visitsSource.slice(updateStart, deleteStart)
    const deleteBody = visitsSource.slice(deleteStart)

    ;[updateBody, deleteBody].forEach((commandBody) => {
      const patientLock = commandBody.indexOf('lockPatient(phaseEm')
      const visitLock = commandBody.indexOf('lockVisit(phaseEm')
      const versionCheck = commandBody.indexOf('assertExpectedVersion(')
      expect(patientLock).toBeGreaterThan(-1)
      expect(visitLock).toBeGreaterThan(patientLock)
      expect(versionCheck).toBeGreaterThan(visitLock)
    })
  })

  it('serializes shared therapist and room slots before recalculating conflicts', () => {
    expect(visitsSource).toContain('pg_advisory_xact_lock(hashtextextended(?::text, 0))')
    expect(visitsSource).toContain('visit_schedule_locked')
    const createStart = visitsSource.indexOf('const createVisitCommand')
    const updateStart = visitsSource.indexOf('const updateVisitCommand')
    const deleteStart = visitsSource.indexOf('const deleteVisitCommand')
    for (const body of [
      visitsSource.slice(createStart, updateStart),
      visitsSource.slice(updateStart, deleteStart),
    ]) {
      const patientLock = body.indexOf('lockPatient(phaseEm')
      const advisoryLock = body.indexOf('acquireVisitSubjectLocks(phaseEm')
      const evaluation = body.indexOf('evaluateCommandConflicts({')
      expect(advisoryLock).toBeGreaterThan(patientLock)
      expect(evaluation).toBeGreaterThan(advisoryLock)
    }
  })

  it('requires an exact warning decision and emits only identifier-safe override events', () => {
    expect(visitsSource).toContain("error: 'visit_conflict_blocking'")
    expect(visitsSource).toContain("error: 'visit_conflict_unacknowledged'")
    expect(visitsSource).toContain("requireReferenceFeature(ctx, scope, 'patient.visits.override_conflict')")
    expect(visitsSource).toContain("emitPatientEvent('patient.visit.conflict_overridden'")
    const eventBodies = visitsSource.match(/emitPatientEvent\('patient\.visit\.conflict_overridden',[\s\S]*?\n\s*}\)/g) ?? []
    expect(eventBodies).toHaveLength(2)
    for (const body of eventBodies) {
      expect(body).toContain('codes: conflictDecision.current.codes')
      expect(body).not.toContain('reason:')
      expect(body).not.toContain('teamMemberName')
    }
  })

  it('binds conflict acknowledgements into create idempotency and audit undo', () => {
    const createStart = visitsSource.indexOf('const createVisitCommand')
    const updateStart = visitsSource.indexOf('const updateVisitCommand')
    const createBody = visitsSource.slice(createStart, updateStart)
    expect(createBody).toContain('acknowledgedSignatures: [...parsed.conflictOverride.acknowledgedSignatures].sort()')
    expect(createBody.indexOf('conflictOverride: parsed.conflictOverride'))
      .toBeLessThan(createBody.indexOf('resolveIdempotentVisit'))
    expect(visitsSource).toContain('snapshot.conflictOverrideReason')
    expect(visitsSource).toContain('visit.conflictOverrideCodes = snapshot.conflictOverrideCodes')
  })

  it('keeps omitted services unchanged, soft-deletes removals, and creates additions', () => {
    expect(visitsSource).toContain('if (parsed.serviceProductIds === undefined) return')
    expect(visitsSource).toContain('deletedAt: updatedAt')
    expect(visitsSource).toContain('phaseEm.create(PatientVisitService')
    expect(visitsSource).toContain('{ position, updatedAt, updatedByUserId: actorUserId }')
  })

  it('gates every selectable installed reference through its owner feature', () => {
    expect(visitsSource).toContain("requireReferenceFeature(ctx, scope, 'staff.view')")
    expect(visitsSource).toContain("requireReferenceFeature(ctx, scope, 'resources.view')")
    expect(visitsSource).toContain("requireReferenceFeature(ctx, scope, 'catalog.products.view')")
    expect(visitsSource.indexOf('await requireCreateReferenceFeatures(ctx, scope, parsed)'))
      .toBeLessThan(visitsSource.indexOf('const replayed = await resolveIdempotentVisit'))
  })

  it('maps duplicate services and semantic scheduling failures to domain statuses', () => {
    expect(visitsSource).toContain("code: 'visit_service_duplicate'")
    expect(visitsSource).toContain("code: 'visit_end_not_after_start'")
    expect(visitsSource).toContain("code: 'visit_time_zone_mismatch'")
  })

  it('bounds the written visit span so availability expansion stays bounded on both writes', () => {
    // create and update both reach the single chokepoint that enforces the ceiling.
    expect(visitsSource).toContain('PATIENT_VISIT_MAX_SPAN_MS')
    expect(visitsSource).toContain("code: 'visit_span_too_long'")
    expect(visitsSource.match(/assertSchedule\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  /**
   * `makeCrudRoute` guards only the HTTP caller. A command-bus caller — an AI tool, a CLI
   * task, an import job, a subscriber — reaches `execute` directly, so each write command has
   * to assert the feature itself rather than inherit it from its route.
   */
  it('asserts visits.manage inside every write command, not only on the route', () => {
    const guards = visitsSource.match(/requireReferenceFeature\(ctx, scope, 'patient\.visits\.manage'\)/g) ?? []
    // create, update, delete, the undo handler, and the override path.
    expect(guards.length).toBeGreaterThanOrEqual(5)
    for (const schema of [
      'patientVisitCreateSchema',
      'patientVisitUpdateSchema',
      'patientVisitDeleteSchema',
    ]) {
      // Anchor on `execute`, not on the first `parse` — `update` and `delete` also parse in
      // `prepare`, which legitimately has no guard because it only reads.
      const at = visitsSource.indexOf(
        `async execute(rawInput, ctx) {\n    const parsed = ${schema}.parse(rawInput)`,
      )
      expect(at).toBeGreaterThan(-1)
      const window = visitsSource.slice(at, at + 500)
      expect(window).toContain("requireReferenceFeature(ctx, scope, 'patient.visits.manage')")
    }
  })

  /**
   * A transient resource read must not turn a known-inactive room into a bookable one: the
   * blocking `resource_inactive` needs `isActive === false`, and `undefined` degrades to the
   * non-blocking `availability_unknown`.
   */
  it('carries the resolved resource activity flag into conflict evaluation', () => {
    expect(visitsSource).toContain('resourceIsActive: resolved.resource?.isAvailable')
    expect(visitsSource).toContain('resourceIsActive: resource === undefined ? undefined : resource?.isAvailable')
  })

  it('serializes create/archive and blocks patient deletion whenever visit history exists', () => {
    expect(visitsSource).toContain('assertPatientAcceptsNewEntries(patient)')
    expect(patientsSource).toContain("status: 'planned'")
    expect(patientsSource).toContain("code: 'patient_has_planned_visits'")
    expect(patientsSource).toContain('counts: { diagnoses, documentLinks, attachmentLinks, visits }')
    expect(patientsSource).toContain('A visit tombstone is still care history')
  })

  it('guards undo with scope, current versions, current features, and the same lock order', () => {
    expect(visitsSource).toContain('Undo scope does not match the visit scope')
    expect(visitsSource).toContain("requireReferenceFeature(ctx, scope, 'patient.visits.manage')")
    expect(visitsSource).toContain('assertExpectedVersion(after.updatedAt, visit.updatedAt')
    expect(visitsSource).toContain('assertPatientAcceptsNewEntries(patient)')
    expect(visitsSource).toContain('restoreVisitServices(')
    const authorization = visitsSource.slice(
      visitsSource.indexOf('export async function authorizeSnapshotReferences'),
      visitsSource.indexOf('async function encryptVisitSnapshot'),
    )
    expect(authorization).not.toContain('requireActiveTeamMember')
    expect(authorization).not.toContain('requireActiveResource')
    expect(authorization).not.toContain('requireActiveProducts')
  })

  it('never indexes care usage globally and emits generic CRUD only through the post-commit pipeline', () => {
    expect(visitsSource).not.toContain('CrudIndexerConfig')
    expect(visitsSource).toContain('events: patientVisitCrudEvents')
    const updateBody = visitsSource.slice(
      visitsSource.indexOf('const updateVisitCommand'),
      visitsSource.indexOf('const deleteVisitCommand'),
    )
    expect(updateBody.match(/emitPatientEvent\('patient\.visit\.unconfirmed'/g)).toHaveLength(1)
  })

  it('guards lifecycle actions in the command, serializes one visit version, and emits only dedicated events', () => {
    const start = visitsSource.indexOf('async function executeVisitLifecycleAction')
    const end = visitsSource.indexOf('function createVisitLifecycleCommand', start)
    const body = visitsSource.slice(start, end)
    const featureCheck = body.indexOf('requireVisitFeatures(')
    const patientLock = body.indexOf('lockPatient(phaseEm')
    const visitLock = body.indexOf('lockVisit(phaseEm')
    const versionCheck = body.indexOf('assertExpectedVersion(')
    expect(featureCheck).toBeGreaterThan(-1)
    expect(patientLock).toBeGreaterThan(featureCheck)
    expect(visitLock).toBeGreaterThan(patientLock)
    expect(versionCheck).toBeGreaterThan(visitLock)
    expect(body).not.toContain('events: patientVisitCrudEvents')
    expect(body).toContain("emitPatientEvent('patient.visit.confirmed'")
    expect(body).toContain("emitPatientEvent('patient.visit.status_changed'")
    expect(body).toContain("emitPatientEvent('patient.visit.settlement_changed'")
    expect(visitsSource).toContain("['patient.visits.manage', 'patient.visits.correct']")
    expect(visitsSource).toContain("return ['patient.visits.settle']")
    expect(visitsSource).toContain("if (target === 'planned') assertPatientAcceptsNewEntries(patient)")
    expect(visitsSource).not.toMatch(/from ['\"]@open-mercato\/(?:[^'\"]*\/)?(?:sales|payment)/)
  })
})
