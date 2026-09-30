export const metadata = {
  requireAuth: true,
  requireFeatures: ['patient.visits.manage', 'patient.patients.view'],
  pageTitle: 'Schedule visit',
  pageTitleKey: 'patient.visits.create.title',
  pageGroup: 'Care',
  pageGroupKey: 'patient.nav.group',
  pageOrder: 111,
  icon: 'calendar-clock',
  breadcrumb: [
    { label: 'Visits', labelKey: 'patient.visits.title', href: '/backend/patient/visits' },
    { label: 'Schedule visit', labelKey: 'patient.visits.create.title' },
  ],
}
