import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { NextResponse } from 'next/server'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { enforcePublicBookingReadRateLimit } from './publicRateLimit'
import { resolvePublicBookingRequestContext } from './publicAuth'

export async function buildPublicBookingReadContext(request: Request): Promise<{
  container: AwilixContainer
  em: EntityManager
  queryEngine: QueryEngine
  scope: { tenantId: string; organizationId: string }
  rateLimitResponse: Response | null
}> {
  const container = await createRequestContainer()
  const rateLimitResponse = await enforcePublicBookingReadRateLimit(request, container)
  const em = container.resolve<EntityManager>('em')
  const queryEngine = container.resolve<QueryEngine>('queryEngine')
  const { scope } = await resolvePublicBookingRequestContext(em, container)
  return { container, em, queryEngine, scope, rateLimitResponse }
}

export function publicBookingErrorResponse(error: unknown): Response {
  if (isCrudHttpError(error)) {
    return NextResponse.json(error.body, { status: error.status })
  }
  return NextResponse.json({ error: 'Public booking is temporarily unavailable' }, { status: 503 })
}
