import { writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import { createCustomerBootstrapDependencies, type BootstrapScope } from './customer-bootstrap'
import {
  CRM_RECONCILIATION_CONFIRMATION,
  reconcileCrmCustomers,
} from './crm-reconciliation'
import {
  createCatalogBootstrapDependencies,
  planPolanaCatalog,
  seedPolanaCatalog,
} from './catalog-bootstrap'

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token?.startsWith('--')) continue
    const [key, inlineValue] = token.slice(2).split('=', 2)
    if (inlineValue !== undefined) args[key!] = inlineValue
    else if (rest[index + 1] && !rest[index + 1]!.startsWith('--')) args[key!] = rest[index += 1]!
    else args[key!] = true
  }
  return args
}

async function writeBackup(path: string, data: unknown): Promise<void> {
  const destination = resolve(path)
  const temporary = `${destination}.tmp-${process.pid}`
  if (!dirname(destination)) throw new Error('Invalid backup path')
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const reconcileCrm: ModuleCli = {
  command: 'reconcile-crm',
  async run(rest) {
    const args = parseArgs(rest)
    const tenantId = typeof args.tenant === 'string' ? args.tenant : ''
    const organizationId = typeof args.organization === 'string' ? args.organization : ''
    if (!tenantId || !organizationId) {
      throw new Error('Usage: mercato polana_bootstrap reconcile-crm --tenant <id> --organization <id> [--execute --backup <path> --confirm replace-known-crm-examples]')
    }
    if (process.env.NODE_ENV === 'production') throw new Error('CRM reconciliation is disabled in production')

    const scope: BootstrapScope = { tenantId, organizationId }
    const container = await createRequestContainer() as AppContainer
    const em = container.resolve('em') as EntityManager
    const dependencies = createCustomerBootstrapDependencies(em, container)
    const preview = await reconcileCrmCustomers(dependencies, scope)
    console.log(JSON.stringify({ mode: 'dry-run', scope, ...preview.plan }, null, 2))
    if (args.execute !== true) return

    if (typeof args.backup !== 'string') throw new Error('--backup is required with --execute')
    if (args.confirm !== CRM_RECONCILIATION_CONFIRMATION) {
      throw new Error(`--confirm must equal ${CRM_RECONCILIATION_CONFIRMATION}`)
    }
    const people = await dependencies.listPeople(scope)
    const matchedIds = new Set(preview.plan.legacyMatches.map((match) => match.id))
    const addresses = await dependencies.listAddresses(scope)
    await writeBackup(args.backup, {
      schemaVersion: 1,
      kind: 'polana_bootstrap.crm-reconciliation',
      createdAt: new Date().toISOString(),
      scope,
      people: people.filter((person) => matchedIds.has(person.id)),
      addresses: addresses.filter((address) => matchedIds.has(typeof address.entity === 'string' ? address.entity : address.entity.id)),
    })
    const result = await reconcileCrmCustomers(dependencies, scope, { execute: true })
    console.log(JSON.stringify({ mode: 'execute', scope, ...result }, null, 2))
  },
}

const installCatalog: ModuleCli = {
  command: 'install-catalog',
  async run(rest) {
    const args = parseArgs(rest)
    const tenantId = typeof args.tenant === 'string' ? args.tenant : ''
    const organizationId = typeof args.organization === 'string' ? args.organization : ''
    if (!tenantId || !organizationId) {
      throw new Error('Usage: mercato polana_bootstrap install-catalog --tenant <id> --organization <id> [--execute --confirm install-polana-catalog]')
    }
    if (process.env.NODE_ENV === 'production') throw new Error('Catalog installation is disabled in production')
    const scope: BootstrapScope = { tenantId, organizationId }
    const container = await createRequestContainer() as AppContainer
    try {
      const em = container.resolve('em') as EntityManager
      const dependencies = createCatalogBootstrapDependencies(em, container)
      const plan = await planPolanaCatalog(dependencies, scope)
      console.log(JSON.stringify({ mode: 'dry-run', scope, plan }, null, 2))
      if (args.execute !== true) return
      if (args.confirm !== 'install-polana-catalog') throw new Error('--confirm must equal install-polana-catalog')
      const result = await seedPolanaCatalog(dependencies, scope)
      console.log(JSON.stringify({ mode: 'execute', scope, result }, null, 2))
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      await disposable.dispose?.()
    }
  },
}

const commands = [reconcileCrm, installCatalog]

export default commands
