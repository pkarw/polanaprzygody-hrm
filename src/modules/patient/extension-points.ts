import {
  crudFormExtensionHost,
  dataTableExtensionHost,
  defineModuleExtensionPoints,
} from '@open-mercato/shared/modules/widgets/extension-points'

/**
 * Extension hosts this module exposes to OTHER modules.
 *
 * Both ids come straight from the spec's UI contract (`entityId=patient:patient`,
 * `extensionTableId=patient.patients.list`, `crud-form:patient.patient`). The
 * declared `source` files READ these entries (`extensionPoints.hosts.<key>.…`)
 * instead of repeating the literal, because the fact extractor looks for exactly
 * that direction — a duplicated string leaves the host recorded as an unbound
 * declaration even though the spot works at runtime.
 *
 * `patientForm.entityId` is dot-separated because `CrudForm` normalizes its
 * `entityId` prop (`patient:patient`) to `patient.patient` when deriving the spot id.
 *
 * Note what is deliberately NOT hosted: the diagnoses, documents and files tabs.
 * Opening those as injection spots would let another module render inside a surface
 * that shows clinical content, and this module cannot vouch for a foreign widget's
 * feature checks.
 */
export const extensionPoints = defineModuleExtensionPoints({
  moduleId: 'patient',
  hosts: {
    patientsTable: dataTableExtensionHost({
      tableId: 'patient.patients.list',
      source: 'components/PatientsTable.tsx',
    }),
    patientForm: crudFormExtensionHost({
      entityId: 'patient.patient',
      spotId: 'crud-form:patient.patient',
      source: 'components/PatientForm.tsx',
    }),
    visitsTable: dataTableExtensionHost({
      tableId: 'patient.visits.list',
      source: 'components/VisitsTable.tsx',
    }),
    visitForm: crudFormExtensionHost({
      entityId: 'patient.visit',
      spotId: 'crud-form:patient.visit',
      source: 'components/VisitForm.tsx',
    }),
  },
})

export default extensionPoints
