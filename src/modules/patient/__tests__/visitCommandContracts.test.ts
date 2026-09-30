import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'

const visitsSource = readFileSync(path.join(__dirname, '..', 'commands', 'visits.ts'), 'utf8')
const patientsSource = readFileSync(path.join(__dirname, '..', 'commands', 'patients.ts'), 'utf8')

describe('visit command invariants', () => {
  it('registers exactly one aggregate CRUD command per public write', () => {
    expect(visitsSource).toContain("id: 'patient.visits.create'")
    expect(visitsSource).toContain("id: 'patient.visits.update'")
    expect(visitsSource).toContain("id: 'patient.visits.delete'")
    expect(visitsSource.match(/registerCommand\(/g)).toHaveLength(3)
    expect(visitsSource.match(/isUndoable: true/g)).toHaveLength(3)
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
    expect(visitsSource.match(/emitPatientEvent\('patient\.visit\.unconfirmed'/g)).toHaveLength(1)
  })
})
