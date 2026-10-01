import { describe, expect, it, jest } from '@jest/globals'
import { defaultEncryptionMaps } from '../encryption'
import { bookingIntakeRecordSchema } from '../data/validators'
import {
  encryptPublicBookingFields,
  requirePublicBookingScope,
} from '../lib/commandSupport'
import { recordBookingIntakeCommand } from '../commands/intake'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

describe('public booking intake contracts', () => {
  it('declares only the intended sensitive columns', () => {
    expect(defaultEncryptionMaps).toEqual([
      {
        entityId: 'public_booking:booking_intake',
        fields: [
          { field: 'requester_name_snapshot' },
          { field: 'requester_email_snapshot' },
          { field: 'requester_phone_snapshot' },
          { field: 'consent_proof' },
        ],
      },
      {
        entityId: 'public_booking:service_credential',
        fields: [{ field: 'api_key_secret' }],
      },
    ])
  })

  it('accepts a bounded, validator-complete intake and rejects scope injection', () => {
    const valid = {
      visitId: '33333333-3333-4333-8333-333333333333',
      customerEntityId: '44444444-4444-4444-8444-444444444444',
      patientId: '55555555-5555-4555-8555-555555555555',
      productId: '66666666-6666-4666-8666-666666666666',
      requesterNameSnapshot: 'Anna Kowalska',
      requesterEmailSnapshot: 'ANNA@example.com',
      requesterPhoneSnapshot: '+48123456789',
      consentProof: {
        terms: { url: 'https://example.test/regulamin', acceptedAt: '2026-10-01T10:00:00+02:00' },
        privacyPolicy: { url: 'https://example.test/privacy', acceptedAt: '2026-10-01T10:00:00+02:00' },
      },
      clientIdempotencyKey: 'request-00000001',
      requestPayloadHash: 'a'.repeat(64),
    }
    expect(bookingIntakeRecordSchema.parse(valid).requesterEmailSnapshot).toBe('anna@example.com')
    expect(() => bookingIntakeRecordSchema.parse({ ...valid, tenantId: scope.tenantId })).toThrow()
  })

  it('derives both scope values from trusted command context and fails closed', () => {
    const container = { resolve: jest.fn() }
    expect(requirePublicBookingScope({
      container,
      auth: { tenantId: scope.tenantId, orgId: scope.organizationId },
    } as never)).toEqual(scope)
    expect(() => requirePublicBookingScope({ container, auth: { tenantId: scope.tenantId } } as never))
      .toThrow('Tenant and organization context are required')
  })

  it('refuses missing/pass-through encryption and returns only ciphertext', async () => {
    await expect(encryptPublicBookingFields(
      'public_booking:booking_intake',
      { requesterNameSnapshot: 'Anna' },
      scope,
      null,
    )).rejects.toMatchObject({ status: 503 })

    await expect(encryptPublicBookingFields(
      'public_booking:booking_intake',
      { requesterNameSnapshot: 'Anna' },
      scope,
      { encryptEntityPayload: async (_entity, payload) => payload },
    )).rejects.toMatchObject({ status: 503 })

    await expect(encryptPublicBookingFields(
      'public_booking:booking_intake',
      { requesterNameSnapshot: 'Anna', requesterEmailSnapshot: null },
      scope,
      { encryptEntityPayload: async () => ({ requesterNameSnapshot: 'ciphertext' }) },
    )).resolves.toEqual({ requesterNameSnapshot: 'ciphertext', requesterEmailSnapshot: null })
  })

  it('persists encrypted snapshots in the trusted scope', async () => {
    const persisted: unknown[] = []
    const em = {
      fork: () => em,
      findOne: jest.fn<(entity: unknown, where: unknown) => Promise<unknown>>(async () => null),
      create: jest.fn((_entity: unknown, value: Record<string, unknown>) => ({
        id: '77777777-7777-4777-8777-777777777777',
        ...value,
      })),
      persist: jest.fn((value: unknown) => { persisted.push(value) }),
      flush: jest.fn(async () => undefined),
    }
    const encryption = {
      encryptEntityPayload: jest.fn<(
        entityId: string,
        value: Record<string, unknown>,
        tenantId: string | null | undefined,
        organizationId?: string | null,
      ) => Promise<Record<string, unknown>>>(async (_entityId, value) => (
          Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, `cipher:${String(entry)}`]))
        )),
    }
    const container = {
      resolve: (token: string) => token === 'em' ? em : encryption,
    }
    const result = await recordBookingIntakeCommand.execute({
      visitId: '33333333-3333-4333-8333-333333333333',
      customerEntityId: '44444444-4444-4444-8444-444444444444',
      patientId: '55555555-5555-4555-8555-555555555555',
      productId: '66666666-6666-4666-8666-666666666666',
      requesterNameSnapshot: 'Anna Kowalska',
      requesterEmailSnapshot: 'anna@example.com',
      requesterPhoneSnapshot: '+48123456789',
      consentProof: {
        terms: { url: 'https://example.test/regulamin', acceptedAt: '2026-10-01T10:00:00+02:00' },
        privacyPolicy: { url: 'https://example.test/privacy', acceptedAt: '2026-10-01T10:00:00+02:00' },
      },
      clientIdempotencyKey: 'request-00000001',
      requestPayloadHash: 'a'.repeat(64),
    }, {
      container,
      auth: { tenantId: scope.tenantId, orgId: scope.organizationId },
    } as never)

    expect(em.findOne).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining(scope))
    expect(encryption.encryptEntityPayload).toHaveBeenCalledWith(
      'public_booking:booking_intake',
      expect.objectContaining({ requesterNameSnapshot: 'Anna Kowalska' }),
      scope.tenantId,
      scope.organizationId,
    )
    expect(persisted).toHaveLength(1)
    expect(result).toEqual(expect.objectContaining({
      ...scope,
      requesterNameSnapshot: 'cipher:Anna Kowalska',
      consentProof: expect.stringMatching(/^cipher:/),
    }))
  })

  it('replays the same scoped request and rejects a changed payload', async () => {
    const existing = {
      id: '77777777-7777-4777-8777-777777777777',
      ...scope,
      clientIdempotencyKey: 'request-00000001',
      requestPayloadHash: 'a'.repeat(64),
    }
    const em = { fork: () => em, findOne: jest.fn(async () => existing) }
    const container = { resolve: (token: string) => token === 'em' ? em : null }
    const input = {
      visitId: '33333333-3333-4333-8333-333333333333',
      customerEntityId: '44444444-4444-4444-8444-444444444444',
      patientId: '55555555-5555-4555-8555-555555555555',
      productId: '66666666-6666-4666-8666-666666666666',
      requesterNameSnapshot: 'Anna Kowalska',
      requesterEmailSnapshot: null,
      requesterPhoneSnapshot: '+48123456789',
      consentProof: {
        terms: { url: 'https://example.test/regulamin', acceptedAt: '2026-10-01T10:00:00+02:00' },
        privacyPolicy: { url: 'https://example.test/privacy', acceptedAt: '2026-10-01T10:00:00+02:00' },
      },
      clientIdempotencyKey: 'request-00000001',
      requestPayloadHash: 'a'.repeat(64),
    }
    const ctx = { container, auth: { tenantId: scope.tenantId, orgId: scope.organizationId } } as never
    await expect(recordBookingIntakeCommand.execute(input, ctx)).resolves.toBe(existing)
    await expect(recordBookingIntakeCommand.execute({ ...input, requestPayloadHash: 'b'.repeat(64) }, ctx))
      .rejects.toMatchObject({ status: 409 })
  })
})
