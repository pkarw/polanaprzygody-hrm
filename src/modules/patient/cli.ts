import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import defaultEncryptionMaps from './encryption'

/**
 * Diagnostics for the patient module.
 *
 * This exists because the module fails CLOSED on a sensitive write: if encryption cannot produce
 * ciphertext, the write is refused rather than storing a patient's name in plain text. That is the
 * right behaviour, but from the outside it is indistinguishable from "something is broken", and
 * the causes are all environmental — a tenant created before the module was installed has no
 * `EncryptionMap` rows, the feature flag may be off, or the tenant may have no data key.
 *
 * A container-backed probe cannot run under `tsx -e`, which has no bootstrap and fails on missing
 * registrars long before it reaches the bug. A module CLI command is the supported way to get one.
 */

type EncryptionServiceLike = {
  encryptEntityPayload: (
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null,
  ) => Promise<Record<string, unknown>>
}

function parseArgs(rest: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = rest[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = 'true'
    }
  }
  return args
}

/**
 * Proves, per entity and per field, whether a sensitive write would currently be accepted.
 *
 * It encrypts a harmless probe value rather than reading real data: the question is whether the
 * pipeline returns ciphertext, and answering it with a patient's actual name would mean decrypting
 * clinical data to run a diagnostic.
 */
const checkEncryption: ModuleCli = {
  command: 'check-encryption',
  async run(rest) {
    const args = parseArgs(rest)
    const tenantId = args.tenant ?? args.tenantId
    const organizationId = args.org ?? args.organization ?? args.organizationId ?? null

    if (!tenantId) {
      console.error('Tenant id is required: yarn mercato patient check-encryption --tenant <uuid> [--org <uuid>]')
      return
    }

    const { resolve } = await createRequestContainer()
    let encryption: EncryptionServiceLike | null = null
    try {
      encryption = resolve('tenantEncryptionService') as EncryptionServiceLike
    } catch {
      encryption = null
    }

    if (!encryption) {
      console.error('❌ tenantEncryptionService is not registered. Patient writes will be refused.')
      return
    }

    let failures = 0
    for (const map of defaultEncryptionMaps) {
      const probe: Record<string, unknown> = {}
      for (const field of map.fields) probe[field.field] = 'probe-value'

      const encrypted = await encryption.encryptEntityPayload(
        map.entityId,
        { ...probe },
        tenantId,
        organizationId,
      )

      const unprotected = map.fields
        .map((field) => field.field)
        .filter((field) => encrypted?.[field] === probe[field])

      if (unprotected.length === 0) {
        console.log(`✅ ${map.entityId} — all ${map.fields.length} field(s) encrypt`)
      } else {
        failures += 1
        console.log(`❌ ${map.entityId} — ${unprotected.length}/${map.fields.length} field(s) returned unchanged`)
        console.log(`   fields: ${unprotected.join(', ')}`)
      }
    }

    if (failures === 0) {
      console.log('\n✅ Patient writes will be accepted for this scope.')
      return
    }

    // The remedy, in the order the causes actually occur.
    console.log('\n❌ Patient writes will be REFUSED for this scope (fail-closed; nothing is stored in plain text).')
    console.log('   1. Most likely: this tenant predates the patient module, so its encryption maps were never created.')
    console.log(`      Run: yarn mercato entities seed-encryption --tenant ${tenantId}`)
    console.log('   2. Check TENANT_DATA_ENCRYPTION is enabled.')
    console.log('   3. Check the tenant has a usable data key (the KMS logs a warning when it falls back to a derived key).')
    console.log('   4. If the maps were seeded only moments ago, a running server may still hold a negative cache for up to 5 minutes — restart it.')
  },
}

/** Named before export so the array is not an anonymous default (import/no-anonymous-default-export). */
const cli = [checkEncryption]

export default cli
