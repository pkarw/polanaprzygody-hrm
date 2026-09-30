import type { CustomEntitySpec } from '@open-mercato/shared/modules/entities'

export const PATIENT_ENTITY_ID = 'patient:patient' as const

/**
 * Registers `patient:patient` as a custom-field host.
 *
 * `fields` is intentionally absent rather than empty. PAT-R03 asks for custom
 * fields that an administrator defines, sets, edits and clears — it does not
 * specify any built-in field, and inventing one here would put an undeclared
 * clinical-looking field on every tenant's record. The registration alone is what
 * the `entities` module needs to accept per-tenant definitions for this entity and
 * what lets `CrudForm`/`DataTable` resolve them by `entityId`.
 *
 * `showInSidebar: false` because the record has its own authored pages under
 * `/backend/patient/patients`; the generic custom-entity browser would be a second,
 * unscoped way into clinical data.
 *
 * `accessRestricted` is left at its default. Access is already gated by this
 * module's own `patient.*` features on every authored route; adding the generic
 * `entities.records.*` grant on top would create a second, divergent ACL for the
 * same records.
 */
export const entities: CustomEntitySpec[] = [
  {
    id: PATIENT_ENTITY_ID,
    label: 'Patient',
    description: 'Patient record custom fields.',
    labelField: 'patient_number',
    showInSidebar: false,
  },
]

export default entities
