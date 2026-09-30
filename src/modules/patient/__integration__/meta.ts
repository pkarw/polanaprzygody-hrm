/**
 * Integration metadata for the `patient` module.
 *
 * `dependsOnModules` is what the discovery layer uses to skip this suite when a required module
 * is not enabled, rather than letting it fail with a confusing 404 on a host route.
 *
 * - `patient` — the module under test.
 * - `auth`, `directory` — the login and organization-scope machinery every spec needs.
 * - `customers` — the CRM people the contact-link specs pick from.
 * - `staff` — the team members the lead-carer specs pick from.
 * - `documents` — the document-link specs pin and create real documents.
 * - `entities` — the custom-field definitions PAT-T04 installs and clears.
 *
 * `attachments` is deliberately absent. PAT-T09 asserts the SEC-ATT gate REFUSES clinical file
 * storage, which is true whether or not the attachments module is enabled, so requiring it would
 * skip the very suite that documents why the phase is disabled.
 */
export const integrationMeta = {
  dependsOnModules: [
    'patient',
    'auth',
    'directory',
    'customers',
    'staff',
    'catalog',
    'resources',
    'documents',
    'entities',
  ],
}

export default integrationMeta
