import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, jest } from '@jest/globals'
import { hasCompletePatientSearchScope } from '../lib/searchScope'

describe('patient search scope guard', () => {
  it.each([
    [{ tenantId: 'tenant-1', organizationId: null }],
    [{ tenantId: null, organizationId: 'org-1' }],
    [{ tenantId: null, organizationId: null }],
  ])('prevents lookup work for incomplete scope %p', (scope) => {
    const lookup = jest.fn()
    if (hasCompletePatientSearchScope(scope)) lookup()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('guards both route helpers before their first database or token-index lookup', () => {
    const source = readFileSync(path.join(__dirname, '..', 'api', 'patients', 'route.ts'), 'utf8')
    const search = source.slice(
      source.indexOf('export async function resolvePatientSearchIds'),
      source.indexOf('type PatientEncryptedFilter'),
    )
    const encrypted = source.slice(
      source.indexOf('export async function resolvePatientEncryptedFieldIds'),
      source.indexOf('function intersectPatientIds'),
    )

    for (const helper of [search, encrypted]) {
      const guard = helper.indexOf('if (!hasCompletePatientSearchScope(scope)) return []')
      expect(guard).toBeGreaterThan(-1)
      const lookups = ['scope.em.find(', 'findWithDecryption(', 'findEntityIdsBySearchTokens(']
        .map((needle) => helper.indexOf(needle))
        .filter((index) => index >= 0)
      expect(lookups.length).toBeGreaterThan(0)
      expect(guard).toBeLessThan(Math.min(...lookups))
    }
  })
})
