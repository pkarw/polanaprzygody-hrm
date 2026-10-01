import { describe, expect, it, jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { publicBookingRequestSchema } from '../data/validators'
import { enforcePublicBookingSubmitRateLimit } from '../lib/publicRateLimit'
import {
  assertPublicBookingRequestSize,
  configuredPublicBookingOrigins,
  publicBookingPayloadHash,
  publicBookingSubmissionError,
  publicBookingUuidV5,
  validatePublicBookingOrigin,
} from '../lib/publicSubmission'

const valid = {
  productId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  startsAt: '2026-10-03T08:00:00+00:00',
  endsAt: '2026-10-03T09:00:00+00:00',
  timeZone: 'Europe/Warsaw' as const,
  requester: {
    firstName: ' Anna ',
    lastName: 'Kowalska',
    email: 'ANNA@EXAMPLE.COM',
    phone: '+48 790 512 258',
  },
  patient: {
    firstName: 'Jan',
    lastName: 'Kowalski',
    address: { street: 'Leśna 1', postalCode: '50-001', city: 'Wrocław', country: 'pl' },
  },
  consents: { terms: true as const, privacyPolicy: true as const },
}

describe('public booking submission contracts', () => {
  it('strictly validates consent and rejects caller-owned scope', () => {
    const parsed = publicBookingRequestSchema.parse(valid)
    expect(parsed.requester).toEqual(expect.objectContaining({ firstName: 'Anna', email: 'anna@example.com' }))
    expect(parsed.patient.address.country).toBe('PL')
    expect(() => publicBookingRequestSchema.parse({ ...valid, tenantId: valid.productId })).toThrow()
    expect(() => publicBookingRequestSchema.parse({ ...valid, consents: { terms: false, privacyPolicy: true } })).toThrow()
  })

  it('hashes semantically equivalent normalized payloads identically', () => {
    const first = publicBookingRequestSchema.parse(valid)
    const second = publicBookingRequestSchema.parse({
      ...valid,
      startsAt: '2026-10-03T10:00:00+02:00',
      endsAt: '2026-10-03T11:00:00+02:00',
      requester: { ...valid.requester, email: 'anna@example.com' },
      patient: { ...valid.patient, address: { ...valid.patient.address, country: 'PL' } },
    })
    expect(publicBookingPayloadHash(first)).toBe(publicBookingPayloadHash(second))
  })

  it('implements standard UUIDv5 with correct version and variant', () => {
    const result = publicBookingUuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')
    expect(result).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
    expect(result[14]).toBe('5')
    expect(['8', '9', 'a', 'b']).toContain(result[19])
  })

  it('accepts only configured host and origin, including safe loopback aliases', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, APP_URL: 'http://localhost:3300' }
    expect(configuredPublicBookingOrigins(env)).toEqual(expect.arrayContaining([
      'http://localhost:3300',
      'http://127.0.0.1:3300',
    ]))
    const request = new Request('http://127.0.0.1:3300/api/public/booking/requests', {
      method: 'POST',
      headers: { host: '127.0.0.1:3300', origin: 'http://localhost:3300' },
    })
    expect(() => validatePublicBookingOrigin(request, env)).not.toThrow()
    expect(() => validatePublicBookingOrigin(new Request(request.url, {
      method: 'POST',
      headers: { host: 'evil.example', origin: 'https://evil.example' },
    }), env)).toThrow('Invalid request host')
  })

  it('bounds anonymous bodies and redacts visit conflict details', () => {
    expect(() => assertPublicBookingRequestSize(new Request('https://example.test', {
      headers: { 'content-length': String(32 * 1024 + 1) },
    }))).toThrow('Invalid booking request')
    const mapped = publicBookingSubmissionError(new CrudHttpError(422, {
      error: 'visit_conflict_blocking',
      conflicts: [{ conflictingVisitId: 'secret', subjectName: 'private' }],
    }))
    expect(mapped).toEqual({ status: 409, body: { error: 'The selected appointment time is no longer available' } })
    expect(JSON.stringify(mapped)).not.toContain('secret')
    expect(JSON.stringify(mapped)).not.toContain('private')
  })

  it('fails closed when the submit limiter is missing or degraded', async () => {
    const request = new Request('https://example.test/api/public/booking/requests', { method: 'POST' })
    const missing = await enforcePublicBookingSubmitRateLimit(request, {
      hasRegistration: () => false,
      resolve: jest.fn(),
    })
    expect(missing?.status).toBe(503)

    const degraded = await enforcePublicBookingSubmitRateLimit(request, {
      hasRegistration: () => true,
      resolve: () => ({
        trustProxyDepth: 0,
        consume: jest.fn(async () => ({ allowed: true, degraded: true, remainingPoints: 0, msBeforeNext: 0 })),
      }),
    })
    expect(degraded?.status).toBe(503)
  })

  it('keeps audit attribution, advisory locking, guards, safe JSON, and scope checks in the write path', () => {
    const submission = readFileSync(join(process.cwd(), 'src/modules/public_booking/lib/publicSubmission.ts'), 'utf8')
    const route = readFileSync(
      join(process.cwd(), 'src/modules/public_booking/api/public/booking/requests/route.ts'),
      'utf8',
    )
    expect(submission).toContain("metadata: { actorUserId: ctx.auth.userId }")
    expect(submission).toContain('pg_advisory_xact_lock')
    expect(submission.indexOf('acquireSubmissionLocks')).toBeLessThan(submission.indexOf('findIntakeReplay(transactionalEm'))
    expect(submission).toContain('runRouteMutationGuards({')
    for (const feature of [
      'customers.people.manage',
      'patient.patients.manage',
      'patient.visits.manage',
      'staff.view',
      'resources.view',
      'catalog.products.view',
    ]) expect(submission).toContain(`'${feature}'`)
    expect(route).toContain('readJsonSafe<Record<string, unknown>>(request, {})')
    expect(route).not.toContain('request.json(')
  })
})
