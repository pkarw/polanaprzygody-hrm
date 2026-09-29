/**
 * Deliberately NOT `navHidden`.
 *
 * `buildAdminNav` (@open-mercato/ui/backend/utils/nav) nests a route under the longest
 * already-seen route whose href is a prefix of its own *and* whose nav group matches, so
 * declaring this page in navigation makes it a child of `/backend/patient/patients` rather
 * than a second top-level "Care" entry. The sidebar renders children only while the current
 * path is on the parent's branch, which is what makes "Add patient" a contextual sub-entry
 * instead of permanent chrome — the same shape `customers.people` and `catalog.products`
 * already have.
 *
 * The register's own "Add patient" action stays the primary entry point; this only adds the
 * sidebar affordance and, as a side effect, keeps "Patients" highlighted while the operator
 * is anywhere under `/backend/patient/patients/...` (the parent is marked active whenever it
 * shows children and no child is itself the current page — see `AppShell`).
 *
 * `requireFeatures` still gates the route server-side, so a user without
 * `patient.patients.manage` neither sees the entry nor can reach the URL directly.
 */
export const metadata = {
  requireAuth: true,
  requireFeatures: ['patient.patients.manage'],
  pageTitle: 'Add patient',
  pageTitleKey: 'patient.patients.create.title',
  pageGroup: 'Care',
  pageGroupKey: 'patient.nav.group',
  pageOrder: 101,
  icon: 'user-plus',
  breadcrumb: [
    { label: 'Patients', labelKey: 'patient.patients.title', href: '/backend/patient/patients' },
    { label: 'Add patient', labelKey: 'patient.patients.create.title' },
  ],
}
