import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { resolveAuthFromRequestDetailed } from '@open-mercato/shared/lib/auth/server'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { ServiceCredential } from '../data/entities'
import { readPublicBookingServiceSecret } from './serviceCredential'
import type { PublicBookingScope } from './commandSupport'

export type PublicBookingAuth = {
  sub: string
  userId?: string | null
  tenantId: string
  orgId: string
  keyId?: string | null
  isApiKey?: boolean
  features?: string[]
  roles?: string[]
}

type AuthResolution = {
  status: 'authenticated' | 'missing' | 'invalid' | 'error'
  auth: PublicBookingAuth | null
}

export type PublicBookingRequestContext = {
  auth: PublicBookingAuth
  scope: PublicBookingScope
}

export type PublicBookingAuthDependencies = {
  locateScope(em: EntityManager): Promise<{
    scope: PublicBookingScope
    serviceUserId: string
    apiKeyId: string
  }>
  readSecret(em: EntityManager, scope: PublicBookingScope): Promise<string>
  resolve(request: Request): Promise<AuthResolution>
}

function unavailable(): CrudHttpError {
  return new CrudHttpError(503, {
    error: 'Public booking is temporarily unavailable',
    code: 'service_identity_unavailable',
  })
}

export const defaultPublicBookingAuthDependencies: PublicBookingAuthDependencies = {
  async locateScope(em) {
    // The app has one public storefront. A locator-only read is deliberately capped at
    // two rows so a multi-tenant deployment cannot silently pick the first tenant.
    // Every business read that follows is scoped to the one exact credential found.
    const credentials = await em.find(ServiceCredential, { deletedAt: null }, {
      fields: ['tenantId', 'organizationId', 'serviceUserId', 'apiKeyId'],
      orderBy: { createdAt: 'asc', id: 'asc' },
      limit: 2,
    })
    if (credentials.length !== 1) throw unavailable()
    const [credential] = credentials
    if (!credential.tenantId || !credential.organizationId) throw unavailable()
    return {
      scope: { tenantId: credential.tenantId, organizationId: credential.organizationId },
      serviceUserId: credential.serviceUserId,
      apiKeyId: credential.apiKeyId,
    }
  },
  readSecret: readPublicBookingServiceSecret,
  resolve: resolveAuthFromRequestDetailed as (request: Request) => Promise<AuthResolution>,
}

/**
 * Resolves the self-provisioned service key through the installed auth stack.
 * Secrets are held only in this stack frame and are never returned, logged or cached here.
 */
export async function resolvePublicBookingRequestContext(
  em: EntityManager,
  _container: AwilixContainer,
  dependencies: PublicBookingAuthDependencies = defaultPublicBookingAuthDependencies,
): Promise<PublicBookingRequestContext> {
  try {
    const located = await dependencies.locateScope(em)
    const secret = await dependencies.readSecret(em, located.scope)
    const resolution = await dependencies.resolve(new Request('http://public-booking.internal/', {
      headers: { 'x-api-key': secret },
    }))
    const auth = resolution.auth
    if (
      resolution.status !== 'authenticated'
      || !auth?.isApiKey
      || auth.tenantId !== located.scope.tenantId
      || auth.orgId !== located.scope.organizationId
      || auth.userId !== located.serviceUserId
      || auth.keyId !== located.apiKeyId
    ) {
      throw unavailable()
    }
    return { auth, scope: located.scope }
  } catch (error) {
    if (error instanceof CrudHttpError && error.status === 503) throw error
    throw unavailable()
  }
}
