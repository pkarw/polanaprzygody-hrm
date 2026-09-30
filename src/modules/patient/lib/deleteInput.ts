import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'

/**
 * Flattens the CRUD factory's DELETE input into what the delete commands expect.
 *
 * DELETE is the one verb whose action schema does NOT receive the request body. The factory
 * hands it `{ body, query }` — POST and PUT get the body itself — so a delete action without
 * a `mapInput` passes that wrapper straight to the command, where `id` and
 * `expectedUpdatedAt` are both `undefined` and the command's schema answers 400. Every
 * unlink, unpin and delete in this module failed that way.
 *
 * The body wins over the query for the same key: a client that sends both means the body,
 * and the query is only there because the shared `deleteCrud` helper also puts the id in the
 * URL.
 *
 * The expected version is then taken from the optimistic-lock header when the payload does
 * not carry one. That header IS the framework's channel for it — `CrudForm` attaches it
 * automatically on delete, and `withScopedApiRequestHeaders(buildOptimisticLockHeader(...))`
 * is how a row action attaches it — so a caller that did everything the framework asks of it
 * would otherwise still be refused for not repeating the value in a body. The commands keep
 * requiring it: this widens the HTTP surface, not the contract.
 */
export function buildDeleteCommandInput(raw: unknown, request?: Request): Record<string, unknown> {
  const source = (raw ?? {}) as { body?: unknown; query?: unknown }
  const query = source.query && typeof source.query === 'object' ? (source.query as Record<string, unknown>) : {}
  const body = source.body && typeof source.body === 'object' ? (source.body as Record<string, unknown>) : {}
  const input: Record<string, unknown> = { ...query, ...body }

  if (typeof input.expectedUpdatedAt !== 'string' || input.expectedUpdatedAt.length === 0) {
    const header = request?.headers?.get(OPTIMISTIC_LOCK_HEADER_NAME)
    if (typeof header === 'string' && header.length > 0) input.expectedUpdatedAt = header
  }

  return input
}
