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
    ]) expect(visitsSource).toContain(`id: '${id}'`)
    expect(visitsSource.match(/registerCommand\(/g)).toHaveLength(8)
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

  it('serializes create/archive and blocks patient deletion whenever visit history exists', () => {
    expect(visitsSource).toContain('assertPatientAcceptsNewEntries(patient)')
    expect(patientsSource).toContain("status: 'planned'")
    expect(patientsSource).toContain("code: 'patient_has_planned_visits'")
    expect(patientsSource).toContain('counts: { diagnoses, documentLinks, attachmentLinks, visits }')
    expect(patientsSource).toContain('A visit tombstone is still care history')
  })

  it('guards undo with scope, current versions, active references, and the same lock order', () => {
    expect(visitsSource).toContain('Undo scope does not match the visit scope')
    expect(visitsSource).toContain("requireReferenceFeature(ctx, scope, 'patient.visits.manage')")
    expect(visitsSource).toContain('assertExpectedVersion(after.updatedAt, visit.updatedAt')
    expect(visitsSource).toContain('assertPatientAcceptsNewEntries(patient)')
    expect(visitsSource).toContain('restoreVisitServices(')
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
    expect(visitsSource).not.toMatch(/from ['\"]@open-mercato\/(?:[^'\"]*\/)?(?:sales|payment)/)
  })
})
