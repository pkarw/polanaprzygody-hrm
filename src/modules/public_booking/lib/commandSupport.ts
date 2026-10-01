import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

export type PublicBookingScope = { tenantId: string; organizationId: string }

export type PublicBookingEncryptionService = {
  encryptEntityPayload: (
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null,
  ) => Promise<Record<string, unknown>>
}

export function requirePublicBookingScope(ctx: CommandRuntimeContext): PublicBookingScope {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!tenantId || !organizationId) {
    throw new CrudHttpError(400, {
      error: 'Tenant and organization context are required',
      code: 'scope_required',
    })
  }
  return { tenantId, organizationId }
}

export function resolvePublicBookingEncryption(
  ctx: CommandRuntimeContext,
): PublicBookingEncryptionService | null {
  try {
    return ctx.container.resolve('tenantEncryptionService') as PublicBookingEncryptionService
  } catch {
    return null
  }
}

/** Encrypts a complete sensitive payload and refuses pass-through/plaintext writes. */
export async function encryptPublicBookingFields<T extends Record<string, unknown>>(
  entityId: string,
  values: T,
  scope: PublicBookingScope,
  encryption: PublicBookingEncryptionService | null,
): Promise<T> {
  const sensitive = Object.fromEntries(
    Object.entries(values).filter(([, value]) => typeof value === 'string' && value.length > 0),
  )
  if (Object.keys(sensitive).length === 0) return values
  if (!encryption) throw encryptionUnavailable(entityId)

  const encrypted = await encryption.encryptEntityPayload(
    entityId,
    sensitive,
    scope.tenantId,
    scope.organizationId,
  )
  const result: Record<string, unknown> = { ...values }
  for (const [field, plaintext] of Object.entries(sensitive)) {
    const ciphertext = encrypted[field]
    if (typeof ciphertext !== 'string' || ciphertext === plaintext) {
      throw encryptionUnavailable(entityId)
    }
    result[field] = ciphertext
  }
  return result as T
}

function encryptionUnavailable(entityId: string): CrudHttpError {
  return new CrudHttpError(503, {
    error: 'Public booking data could not be encrypted, so the write was refused',
    code: 'encryption_unavailable',
    entityId,
    remedy: 'Run `yarn mercato entities seed-encryption --tenant <tenantId>` for an existing tenant.',
  })
}
