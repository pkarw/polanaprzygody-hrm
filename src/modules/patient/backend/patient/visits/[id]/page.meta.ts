export const metadata = {
  requireAuth: true,
  requireFeatures: ['patient.visits.view', 'patient.patients.view'],
  navHidden: true,
  pageTitle: 'Visit',
  pageTitleKey: 'patient.visits.detail.title',
  pageGroup: 'Care',
  pageGroupKey: 'patient.nav.group',
  pageOrder: 112,
  icon: 'calendar-clock',
  breadcrumb: [
    { label: 'Visits', labelKey: 'patient.visits.title', href: '/backend/patient/visits' },
    { label: 'Visit', labelKey: 'patient.visits.detail.title' },
  ],
}
