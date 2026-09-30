import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'
import { CommandBus, type CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { slugify } from '@open-mercato/shared/lib/slugify'
import type { BootstrapScope } from './customer-bootstrap'

/** Workspace identity this app installs itself under. */
export const POLANA_ORGANIZATION_NAME = 'Polana Przygody'

/**
 * `mercato init` names the first tenant/organization "Acme Corp" unless the
 * caller passes `--org=`. `scripts/mercato-cli.mjs` now supplies the Polana name
 * on every install, so this hook only has to repair databases created before
 * that default existed — and it repairs nothing an operator renamed on purpose.
 */
export const DEFAULT_INSTALL_ORGANIZATION_NAME = 'Acme Corp'

export type OrganizationBootstrapPlan = {
  organizationRename: { from: string; to: string } | null
  organizationSlugRename: { from: string; to: string } | null
  tenantRename: { from: string; to: string } | null
}

export type OrganizationBootstrapSummary = {
  renamedOrganization: boolean
  renamedOrganizationSlug: boolean
  renamedTenant: boolean
}

function commandContext(container: AwilixContainer, scope: BootstrapScope): CommandRuntimeContext {
  return {
    container,
    auth: { sub: 'system:polana_bootstrap', userId: 'system:polana_bootstrap', tenantId: scope.tenantId, orgId: scope.organizationId },
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    syncOrigin: 'polana_bootstrap:setup',
    systemActor: true,
  }
}

async function resolve(em: EntityManager, scope: BootstrapScope): Promise<{
  organization: Organization | null
  tenant: Tenant | null
  plan: OrganizationBootstrapPlan
}> {
  if (!scope.tenantId || !scope.organizationId) {
    throw new Error('Polana organization bootstrap requires tenantId and organizationId.')
  }
  const organization = await em.findOne(Organization, { id: scope.organizationId, deletedAt: null })
  const tenant = await em.findOne(Tenant, { id: scope.tenantId, deletedAt: null })
  const defaultSlug = slugify(DEFAULT_INSTALL_ORGANIZATION_NAME)
  const targetSlug = slugify(POLANA_ORGANIZATION_NAME)
  const renameOrganization = organization?.name === DEFAULT_INSTALL_ORGANIZATION_NAME
  return {
    organization,
    tenant,
    plan: {
      organizationRename: renameOrganization
        ? { from: DEFAULT_INSTALL_ORGANIZATION_NAME, to: POLANA_ORGANIZATION_NAME }
        : null,
      // Only the slug `directory` auto-derived from the placeholder name is
      // rewritten; a hand-picked slug is somebody's portal URL and stays put.
      organizationSlugRename: renameOrganization && organization?.slug === defaultSlug
        ? { from: defaultSlug, to: targetSlug }
        : null,
      tenantRename: tenant?.name === DEFAULT_INSTALL_ORGANIZATION_NAME
        ? { from: DEFAULT_INSTALL_ORGANIZATION_NAME, to: POLANA_ORGANIZATION_NAME }
        : null,
    },
  }
}

export async function planPolanaOrganization(
  em: EntityManager,
  scope: BootstrapScope,
): Promise<OrganizationBootstrapPlan> {
  const { plan } = await resolve(em, scope)
  return plan
}

export async function seedPolanaOrganization(
  em: EntityManager,
  container: AwilixContainer,
  scope: BootstrapScope,
): Promise<OrganizationBootstrapSummary> {
  const { organization, tenant, plan } = await resolve(em, scope)
  const summary: OrganizationBootstrapSummary = {
    renamedOrganization: false,
    renamedOrganizationSlug: false,
    renamedTenant: false,
  }

  if (organization && plan.organizationRename) {
    const commandBus = container.resolve<CommandBus>('commandBus')
    await commandBus.execute('directory.organizations.update', {
      input: {
        id: organization.id,
        tenantId: scope.tenantId,
        name: POLANA_ORGANIZATION_NAME,
        // The update command rebuilds the org tree from these two fields, so
        // echo the current values back instead of letting them default away.
        parentId: organization.parentId ?? null,
        childIds: Array.isArray(organization.childIds) ? organization.childIds.map(String) : [],
        ...(plan.organizationSlugRename ? { slug: plan.organizationSlugRename.to } : {}),
      },
      ctx: commandContext(container, scope),
    })
    summary.renamedOrganization = true
    summary.renamedOrganizationSlug = plan.organizationSlugRename !== null
  }

  if (tenant && plan.tenantRename) {
    // `directory.tenants.update` is superadmin-gated and this bootstrap runs as
    // an unprivileged system actor. Renaming the tenant label is a one-field
    // identity fixup with no dependents, so write it directly rather than
    // fabricating superadmin rights for a seed.
    tenant.name = POLANA_ORGANIZATION_NAME
    tenant.updatedAt = new Date()
    em.persist(tenant)
    await em.flush()
    summary.renamedTenant = true
  }

  return summary
}
