/**
 * `navHidden` because this destination is reached from the register list's "Add patient"
 * action, and the spec requires create and detail to stay out of navigation. It still
 * declares its own `requireFeatures`, so typing the URL directly is refused by the route
 * guard rather than only being hidden from the sidebar.
 */
export const metadata = {
  requireAuth: true,
  requireFeatures: ['patient.patients.manage'],
  navHidden: true,
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
