/**
 * Feature IDs for the `patient` module.
 *
 * The spec (PAT, "Users, Permissions, and Scope") gates the server and the UI on
 * these ids and never on role names, so every route `metadata`, `page.meta.ts`
 * `requireFeatures`, and command guard references an id from this list.
 *
 * The dependency edges are the spec's, not a convenience: `manage` depends on its
 * own `view`, and the whole clinical surface depends on `patients.view`, because a
 * clinician who cannot see the record has nothing to attach a diagnosis to. The
 * framework resolves `dependsOn` transitively when a grant is evaluated, which is
 * what makes "registration staff can never reach diagnoses" enforceable by
 * granting `patient.patients.*` alone.
 *
 * `patient.configure` is deliberately NOT a parent of the clinical features. The
 * spec is explicit that configuring custom-field definitions is not an implicit
 * right to read documentation.
 */
export const features = [
  {
    id: 'patient.patients.view',
    title: 'View patient records',
    module: 'patient',
  },
  {
    id: 'patient.patients.manage',
    title: 'Manage patient records, addresses and contacts',
    module: 'patient',
    dependsOn: ['patient.patients.view'],
  },
  {
    id: 'patient.clinical.view',
    title: 'View patient clinical documentation',
    module: 'patient',
    dependsOn: ['patient.patients.view'],
  },
  {
    id: 'patient.clinical.manage',
    title: 'Manage patient diagnoses and documentation links',
    module: 'patient',
    dependsOn: ['patient.clinical.view'],
  },
  {
    id: 'patient.configure',
    title: 'Configure patient field definitions',
    module: 'patient',
    dependsOn: ['patient.patients.view'],
  },
  {
    id: 'patient.visits.view',
    title: 'View patient visits',
    module: 'patient',
    dependsOn: ['patient.patients.view'],
  },
  {
    id: 'patient.visits.manage',
    title: 'Plan and manage patient visits',
    module: 'patient',
    dependsOn: ['patient.visits.view'],
  },
  {
    id: 'patient.visits.settle',
    title: 'Mark patient visits as manually settled',
    module: 'patient',
    dependsOn: ['patient.visits.view'],
  },
  {
    id: 'patient.visits.correct',
    title: 'Reopen and correct closed patient visits',
    module: 'patient',
    dependsOn: ['patient.visits.manage'],
  },
  {
    id: 'patient.visits.override_conflict',
    title: 'Override patient visit availability warnings',
    module: 'patient',
    dependsOn: ['patient.visits.manage'],
  },
]

export default features
