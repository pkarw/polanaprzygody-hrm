import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { installCustomEntitiesFromModules } from '@open-mercato/core/modules/entities/lib/install-from-ce'
import { PATIENT_ENTITY_ID } from './ce'
import { ensureVisitPaymentFields } from './lib/visitPaymentFields'

/**
 * Setup for the `patient` module.
 *
 * `defaultRoleFeatures` grants `patient.*` to the administrator roles only. The spec
 * is explicit that setup must not hand `patient.*` to every signed-in user, so
 * `employee` is absent from the map rather than present with a reduced set: the
 * framework merges these grants into existing roles, and listing `employee` here
 * would silently widen an already-deployed role the operator did not ask us to
 * touch. Registration staff (`patient.patients.*`) and clinicians
 * (`patient.clinical.*`) are separated by design, and which employee role gets which
 * is a per-deployment decision made in the roles UI — not a default.
 *
 * `onTenantCreated` installs the custom-entity registration for `patient:patient`,
 * so a tenant created long after `mercato init` can still accept per-tenant custom
 * field definitions (PAT-R03). It receives an `EntityManager` and no container,
 * hence the `null` cache argument — there is nothing cached for a tenant that did
 * not exist a moment ago.
 *
 * There is no `seedDefaults` and no `seedExamples`. The spec forbids demo clinical
 * data outright ("Żadnych przykładowych danych medycznych z rzeczywistych osób"),
 * and this module owns no reference records that a fresh organization needs.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['patient.*'],
    admin: ['patient.*'],
  },

  async onTenantCreated({ em, tenantId }) {
    await installCustomEntitiesFromModules(em, null, {
      entityIds: [PATIENT_ENTITY_ID],
      tenantIds: [tenantId],
      includeGlobal: false,
    })
  },

  async seedDefaults({ em, tenantId, organizationId }) {
    await ensureVisitPaymentFields(em, { tenantId, organizationId })
  },
}

export default setup
