/**
 * Navigation metadata for the patient register.
 *
 * `icon` is `users`, confirmed present in the installed registry
 * (`node_modules/@open-mercato/ui/dist/backend/icons/lucideRegistry.generated.js`). An
 * unlisted Lucide name renders no icon at all and logs nothing, so the name is checked
 * rather than guessed.
 *
 * This is the only patient destination that appears in navigation on its own. The create
 * page nests underneath it as a contextual child (the sidebar reveals children only while
 * the current path is on this branch); the detail page stays out, because its href carries
 * a dynamic `[id]` segment that navigation cannot resolve to a concrete URL.
 *
 * `requireFeatures` mirrors the API's own gate, and does not replace it: hiding the nav
 * entry is a convenience, while `GET /api/patient/patients` refuses the request on its own.
 */
export const metadata = {
  requireAuth: true,
  requireFeatures: ['patient.patients.view'],
  pageTitle: 'Patients',
  pageTitleKey: 'patient.patients.title',
  pageGroup: 'Care',
  pageGroupKey: 'patient.nav.group',
  pageOrder: 100,
  icon: 'users',
  breadcrumb: [{ label: 'Patients', labelKey: 'patient.patients.title' }],
}
