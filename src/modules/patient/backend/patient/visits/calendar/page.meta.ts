export const metadata = {
  requireAuth: true,
  requireFeatures: ['patient.visits.view', 'patient.patients.view'],
  pageTitle: 'Visit calendar',
  pageTitleKey: 'patient.visits.calendar.title',
  pageGroup: 'Care',
  pageGroupKey: 'patient.nav.group',
  pagePriority: 10,
  pageOrder: 111,
  icon: 'calendar',
  breadcrumb: [
    { label: 'Visits', labelKey: 'patient.visits.title', href: '/backend/patient/visits' },
    { label: 'Calendar', labelKey: 'patient.visits.calendar.title' },
  ],
}
