import { POLANA_PERSON_FIXTURES } from './fixtures'
import {
  personInput,
  seedPolanaCustomers,
  type BootstrapScope,
  type CustomerBootstrapDependencies,
  type CustomerBootstrapSummary,
  type CustomerEntityRecord,
} from './customer-bootstrap'

export const LEGACY_CUSTOMER_EMAILS = [
  'mia.johnson@brightsidesolar.com',
  'daniel.cho@brightsidesolar.com',
  'arjun.patel@harborviewanalytics.com',
  'lena.ortiz@harborviewanalytics.com',
  'taylor.brooks@copperleaf.design',
  'naomi.harris@copperleaf.design',
] as const

export const CRM_RECONCILIATION_CONFIRMATION = 'replace-known-crm-examples'

export type CrmReconciliationPlan = {
  legacyMatches: Array<{ id: string; fromEmail: string; toEmail: string }>
  untouchedPeople: number
}

export type CrmReconciliationResult = {
  plan: CrmReconciliationPlan
  bootstrap: CustomerBootstrapSummary | null
}

function normalizedEmail(person: CustomerEntityRecord): string | null {
  return typeof person.primaryEmail === 'string' ? person.primaryEmail.trim().toLowerCase() : null
}

export async function planCrmReconciliation(
  dependencies: CustomerBootstrapDependencies,
  scope: BootstrapScope,
): Promise<CrmReconciliationPlan> {
  if (!scope.tenantId || !scope.organizationId) {
    throw new Error('CRM reconciliation requires explicit tenant and organization scope')
  }

  const people = await dependencies.listPeople(scope)
  const byEmail = new Map(people.map((person) => [normalizedEmail(person), person]))
  const legacyMatches = LEGACY_CUSTOMER_EMAILS.flatMap((fromEmail, index) => {
    const person = byEmail.get(fromEmail)
    if (!person) return []
    const toEmail = POLANA_PERSON_FIXTURES[index]!.email
    const target = byEmail.get(toEmail)
    if (target && target.id !== person.id) {
      throw new Error(`CRM reconciliation conflict: target email ${toEmail} already belongs to another person`)
    }
    return [{ id: person.id, fromEmail, toEmail }]
  })

  return { legacyMatches, untouchedPeople: people.length - legacyMatches.length }
}

export async function reconcileCrmCustomers(
  dependencies: CustomerBootstrapDependencies,
  scope: BootstrapScope,
  options: { execute?: boolean } = {},
): Promise<CrmReconciliationResult> {
  const plan = await planCrmReconciliation(dependencies, scope)
  if (!options.execute) return { plan, bootstrap: null }

  for (const match of plan.legacyMatches) {
    const fixtureIndex = LEGACY_CUSTOMER_EMAILS.indexOf(match.fromEmail as typeof LEGACY_CUSTOMER_EMAILS[number])
    const fixture = POLANA_PERSON_FIXTURES[fixtureIndex]!
    await dependencies.execute('customers.people.update', {
      id: match.id,
      ...personInput(fixture, scope),
    }, scope)
  }

  return {
    plan,
    bootstrap: await seedPolanaCustomers(dependencies, scope),
  }
}
