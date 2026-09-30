export const metadata = {
  requireAuth: true,
  requireFeatures: ['patient.visits.view', 'patient.patients.view'],
  pageTitle: 'Visits',
  pageTitleKey: 'patient.visits.title',
  pageGroup: 'Care',
  pageGroupKey: 'patient.nav.group',
  pageOrder: 110,
  icon: 'calendar-clock',
  breadcrumb: [{ label: 'Visits', labelKey: 'patient.visits.title' }],
}
