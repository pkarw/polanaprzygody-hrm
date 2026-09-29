import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { serializeOperationMetadata } from '@open-mercato/shared/lib/commands/operationMetadata'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('patient').child({ component: 'api' })

export type PatientRouteContext = {
  ctx: CommandRuntimeContext
  translate: (key: string, fallback?: string) => string
}

/**
 * Builds the command context for a custom action route.
 *
 * Scope comes from the session and the selected organization, resolved through the
 * directory module's own helper, never from the payload. Shared by every action route so
 * one of them cannot quietly resolve scope differently from the others.
 */
export async function buildPatientRouteContext(req: Request): Promise<PatientRouteContext> {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(req)
  const { translate } = await resolveTranslations()
  if (!auth) {
    throw new CrudHttpError(401, { error: translate('patient.errors.unauthorized', 'Unauthorized') })
  }
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const ctx: CommandRuntimeContext = {
    container,
    auth,
    organizationScope: scope,
    selectedOrganizationId: scope?.selectedId ?? auth.orgId ?? null,
    organizationIds: scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null),
    request: req,
  }
  return { ctx, translate }
}

/**
 * Server-owned columns that a client may never set through a write route.
 *
 * The spec requires these to be *rejected* with a 400, not silently dropped. Zod's
 * default behaviour is to strip unknown keys, which would accept a request that sets
 * `status` and return 200 while ignoring it — the client would reasonably believe the
 * archive took effect. Naming them explicitly turns that into an error the caller can act
 * on, and keeps the status/lifecycle transitions reachable only through their own
 * commands, where their invariants and separate feature checks live.
 */
export const PATIENT_PROTECTED_KEYS = [
  'patientNumber',
  'status',
  'archivedAt',
  'createRequestPayload',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'createdByUserId',
  'updatedByUserId',
  'authorUserId',
  'voidedAt',
  'voidedByUserId',
  'voidReason',
  'supersedesId',
  'state',
  'contentId',
  'actorId',
  'userId',
] as const

/**
 * Rejects a payload that names a server-owned column.
 *
 * `tenantId` / `organizationId` are handled separately by `parseScopedCommandInput`,
 * which answers a foreign tenant with a 403 rather than a 400 — a different failure with
 * a different meaning, so the two checks stay separate.
 */
export function rejectProtectedKeys(
  body: unknown,
  translate: (key: string, fallback?: string) => string,
  extraKeys: readonly string[] = [],
): void {
  if (!body || typeof body !== 'object') return
  const present = [...PATIENT_PROTECTED_KEYS, ...extraKeys].filter((key) =>
    Object.prototype.hasOwnProperty.call(body, key),
  )
  if (present.length === 0) return
  throw new CrudHttpError(400, {
    error: translate(
      'patient.errors.protectedFields',
      'These fields are set by the server and cannot be supplied',
    ),
    fields: present,
  })
}

/**
 * Turns a thrown error into the response the spec's error matrix prescribes.
 *
 * `CrudHttpError` carries its own status, so 400 / 403 / 404 / 409 / 422 / 503 all pass
 * through with their payload intact. Everything else becomes a generic 500 with the
 * detail logged rather than returned — an unexpected error's message can contain a
 * database fragment, and this module's rows hold clinical data.
 */
export function toPatientErrorResponse(
  err: unknown,
  translate: (key: string, fallback?: string) => string,
  context: string,
): NextResponse {
  if (isCrudHttpError(err)) {
    return NextResponse.json(err.body, { status: err.status })
  }
  const interceptorRejection = getCommandInterceptorHttpRejection(err)
  if (interceptorRejection) {
    return NextResponse.json(interceptorRejection.body, { status: interceptorRejection.status })
  }
  logger.error('Patient API request failed', { context, err })
  return NextResponse.json(
    { error: translate('patient.errors.unexpected', 'The request could not be completed.') },
    { status: 500 },
  )
}

/**
 * Attaches the undo/operation metadata header when the command produced an undoable log
 * entry, so the UI can offer undo through the standard mechanism.
 */
export function attachOperationMetadata(
  response: NextResponse,
  logEntry:
    | {
        id?: string | null
        undoToken?: string | null
        commandId?: string | null
        actionLabel?: string | null
        resourceKind?: string | null
        resourceId?: string | null
        createdAt?: Date | string | null
      }
    | null
    | undefined,
  fallbackResourceKind: string,
): NextResponse {
  if (!logEntry?.undoToken || !logEntry.id || !logEntry.commandId) return response
  response.headers.set(
    'x-om-operation',
    serializeOperationMetadata({
      id: logEntry.id,
      undoToken: logEntry.undoToken,
      commandId: logEntry.commandId,
      actionLabel: logEntry.actionLabel ?? null,
      resourceKind: logEntry.resourceKind ?? fallbackResourceKind,
      resourceId: logEntry.resourceId ?? null,
      // `executedAt` is required by the payload type. The log entry's own timestamp is
      // preferred; a string that already came back serialized is passed through, and only a
      // genuinely absent timestamp falls back to now — which is accurate to within the
      // round trip, since the entry was written by the command this response is for.
      executedAt:
        logEntry.createdAt instanceof Date
          ? logEntry.createdAt.toISOString()
          : typeof logEntry.createdAt === 'string'
            ? logEntry.createdAt
            : new Date().toISOString(),
    }),
  )
  return response
}
