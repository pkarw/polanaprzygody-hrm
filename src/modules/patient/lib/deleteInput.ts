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
 * URL. The version token can only come from the body — it is not a URL-safe value the
 * client should be putting in a query string.
 */
export function buildDeleteCommandInput(raw: unknown): Record<string, unknown> {
  const source = (raw ?? {}) as { body?: unknown; query?: unknown }
  const query = source.query && typeof source.query === 'object' ? (source.query as Record<string, unknown>) : {}
  const body = source.body && typeof source.body === 'object' ? (source.body as Record<string, unknown>) : {}
  return { ...query, ...body }
}
