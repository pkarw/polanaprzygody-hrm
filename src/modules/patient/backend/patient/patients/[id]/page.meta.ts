/**
 * The patient card.
 *
 * `navHidden` — reached from the register list. Unlike the sibling create page, this one
 * could not appear in the sidebar even without the flag: `buildAdminNav` skips every route
 * whose href contains a dynamic segment (`[id]`), because a nav entry needs a concrete URL
 * and there is no patient to point at until one is already open. The flag is kept so the
 * intent is explicit rather than incidental.
 *
 * `requireFeatures` is `patient.patients.view` only. The card itself is a records surface;
 * the clinical tabs it hosts check `patient.clinical.view` for themselves, so a reception
 * user opening this page sees the record and its addresses and contacts, and no diagnoses or
 * documentation. Gating the whole page on the clinical feature would lock reception out of
 * the register entirely.
 */
export const metadata = {
  requireAuth: true,
  requireFeatures: ['patient.patients.view'],
  navHidden: true,
  pageTitle: 'Patient',
  pageTitleKey: 'patient.patients.detail.title',
  pageGroup: 'Care',
  pageGroupKey: 'patient.nav.group',
  pageOrder: 102,
  icon: 'user',
  breadcrumb: [
    { label: 'Patients', labelKey: 'patient.patients.title', href: '/backend/patient/patients' },
    { label: 'Patient', labelKey: 'patient.patients.detail.title' },
  ],
}
