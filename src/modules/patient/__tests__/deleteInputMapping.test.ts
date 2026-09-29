import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'
import { buildDeleteCommandInput } from '../lib/deleteInput'

/**
 * Regression oracle for the bug that broke every delete in this module.
 *
 * DELETE is the one verb whose action schema does NOT receive the request body. The CRUD
 * factory hands `POST` and `PUT` the parsed body, but hands `DELETE` a wrapper:
 *
 *     const raw = { body, query: buildQueryParams(url.searchParams) }
 *     const parsed = action.schema ? action.schema.parse(raw) : raw
 *     const input = action.mapInput ? await action.mapInput({ parsed, raw, ctx }) : parsed
 *
 * A `delete:` action with no `mapInput` therefore passes `{ body, query }` straight to the
 * command, whose schema asks for a flat `{ id, expectedUpdatedAt }` and answers:
 *
 *     400 {"error":"Invalid input","details":[
 *       {"path":["id"],"message":"expected string, received undefined"},
 *       {"path":["expectedUpdatedAt"],"message":"expected string, received undefined"}]}
 *
 * Unlinking a contact, unpinning a document, deleting an address, detaching a file and
 * deleting a patient all failed that way. Nothing caught it: the routes type-check, the
 * clients send a correct body, and no unit test issues an HTTP request.
 *
 * The guard is source-level for the same reason the lock guard is: the alternative needs a
 * live server, and a check that only runs where one is available is a check that does not
 * run.
 */

const API_DIR = path.join(__dirname, '..', 'api')

function listRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listRouteFiles(full))
    else if (entry.name === 'route.ts') out.push(full)
  }
  return out
}

/** The `delete:` action block of a route file, or null when the route declares none. */
function readDeleteAction(source: string): string | null {
  const start = source.indexOf('\n    delete: {')
  if (start === -1) return null
  const end = source.indexOf('\n    },', start)
  return source.slice(start, end === -1 ? source.length : end)
}

describe('patient delete routes flatten the factory DELETE input', () => {
  const routes = listRouteFiles(API_DIR).map((file) => ({
    file: path.relative(API_DIR, file),
    source: readFileSync(file, 'utf8'),
  }))

  it('finds the route files', () => {
    expect(routes.length).toBeGreaterThanOrEqual(6)
  })

  it.each(routes)('$file declares mapInput on its delete action', ({ source }) => {
    const action = readDeleteAction(source)
    if (action === null) return
    expect(action).toContain('buildDeleteCommandInput(raw)')
  })

  describe('buildDeleteCommandInput', () => {
    it('reads the id and the version token from the body', () => {
      expect(
        buildDeleteCommandInput({
          body: { id: 'a', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' },
          query: {},
        }),
      ).toEqual({ id: 'a', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' })
    })

    it('falls back to the query id, which the shared deleteCrud helper also sends', () => {
      expect(buildDeleteCommandInput({ body: {}, query: { id: 'b' } })).toEqual({ id: 'b' })
    })

    it('lets the body win, because a client that sends both means the body', () => {
      expect(buildDeleteCommandInput({ body: { id: 'body' }, query: { id: 'query' } })).toEqual({
        id: 'body',
      })
    })

    it('survives a missing or malformed wrapper rather than throwing into the route', () => {
      expect(buildDeleteCommandInput(undefined)).toEqual({})
      expect(buildDeleteCommandInput({})).toEqual({})
      expect(buildDeleteCommandInput({ body: null, query: 'nonsense' })).toEqual({})
    })
  })
})
