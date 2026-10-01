import { describe, expect, it, jest } from '@jest/globals'
import {
  applyPaymentCompletion,
  type CheckoutTransactionCompletedPayload,
  type PaymentCompletionDependencies,
} from '../lib/visitPaymentCompletion'

const payload: CheckoutTransactionCompletedPayload = {
  transactionId: '11111111-1111-4111-8111-111111111111',
  linkId: '22222222-2222-4222-8222-222222222222',
  status: 'completed',
  occurredAt: '2026-10-01T10:30:00.000Z',
  tenantId: '33333333-3333-4333-8333-333333333333',
  organizationId: '44444444-4444-4444-8444-444444444444',
}

function dependencies(rows: Array<Record<string, unknown>>): PaymentCompletionDependencies & {
  completeVisitForLink: jest.MockedFunction<PaymentCompletionDependencies['completeVisitForLink']>
} {
  return {
    findVisitsByPaymentLink: jest.fn(async () => rows),
    completeVisitForLink: jest.fn(async (): Promise<'ignored' | 'unchanged' | 'updated'> => 'updated'),
  }
}

describe('visit payment completion subscriber', () => {
  it('ignores unmatched links and refuses ambiguous scoped references without mutation', async () => {
    const none = dependencies([])
    await expect(applyPaymentCompletion(payload, none)).resolves.toBe('ignored')
    expect(none.completeVisitForLink).not.toHaveBeenCalled()

    const duplicate = dependencies([{ id: 'visit-a' }, { id: 'visit-b' }])
    await expect(applyPaymentCompletion(payload, duplicate)).rejects.toThrow('Multiple scoped patient visits')
    expect(duplicate.completeVisitForLink).not.toHaveBeenCalled()
  })

  it('writes the event timestamp once and keeps completed absorbing on redelivery', async () => {
    const first = dependencies([{
      id: '55555555-5555-4555-8555-555555555555',
      'cf:payment_link_status': 'processing',
      'cf:payment_received_at': null,
    }])
    await expect(applyPaymentCompletion(payload, first)).resolves.toBe('updated')
    expect(first.completeVisitForLink).toHaveBeenCalledWith(
      '55555555-5555-4555-8555-555555555555',
      payload.linkId,
      payload.occurredAt!,
      { tenantId: payload.tenantId, organizationId: payload.organizationId },
    )

    const replay = dependencies([{ id: '55555555-5555-4555-8555-555555555555' }])
    replay.completeVisitForLink.mockResolvedValue('unchanged')
    await expect(applyPaymentCompletion(payload, replay)).resolves.toBe('unchanged')
    expect(replay.completeVisitForLink).toHaveBeenCalledTimes(1)
  })

  it('keeps a changed link pointer ignored under the serialized write seam', async () => {
    const changed = dependencies([{ id: '55555555-5555-4555-8555-555555555555' }])
    changed.completeVisitForLink.mockResolvedValue('ignored')

    await expect(applyPaymentCompletion(payload, changed)).resolves.toBe('ignored')
    expect(changed.completeVisitForLink).toHaveBeenCalledWith(
      '55555555-5555-4555-8555-555555555555',
      payload.linkId,
      payload.occurredAt!,
      { tenantId: payload.tenantId, organizationId: payload.organizationId },
    )
  })
})
