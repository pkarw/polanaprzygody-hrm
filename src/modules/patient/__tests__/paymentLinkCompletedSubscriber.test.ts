import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { setRecordCustomFields } from '@open-mercato/core/modules/entities/lib/helpers'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { emitPatientEvent } from '../events'
import onPaymentLinkCompleted from '../subscribers/payment-link-completed'

jest.mock('@open-mercato/core/modules/entities/lib/helpers', () => ({
  setRecordCustomFields: jest.fn(async () => undefined),
}))

jest.mock('@open-mercato/shared/lib/crud/custom-fields', () => ({
  loadCustomFieldValues: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))

jest.mock('../events', () => ({
  emitPatientEvent: jest.fn(async () => undefined),
}))

const payload = {
  transactionId: '11111111-1111-4111-8111-111111111111',
  linkId: '22222222-2222-4222-8222-222222222222',
  status: 'completed',
  occurredAt: '2026-10-01T10:30:00.000Z',
  tenantId: '33333333-3333-4333-8333-333333333333',
  organizationId: '44444444-4444-4444-8444-444444444444',
}

const visit = {
  id: '55555555-5555-4555-8555-555555555555',
  patientId: '66666666-6666-4666-8666-666666666666',
  tenantId: payload.tenantId,
  organizationId: payload.organizationId,
  updatedAt: new Date('2026-10-01T10:00:00.000Z'),
}

function configureHarness(customFields: Record<string, unknown>) {
  const query = jest.fn(async () => ({
    items: [{ id: visit.id }],
    page: 1,
    pageSize: 2,
    total: 1,
  }))
  const tx = {
    execute: jest.fn(async () => undefined),
    findOne: jest.fn(async () => visit),
  }
  const rootEm = {
    fork: () => ({ transactional: async <T>(work: (em: typeof tx) => Promise<T>) => await work(tx) }),
  }
  jest.mocked(loadCustomFieldValues).mockResolvedValue({ [visit.id]: customFields })
  jest.mocked(createRequestContainer).mockResolvedValue({
    resolve(token: string) {
      if (token === 'queryEngine') return { query }
      if (token === 'em') return rootEm
      throw new Error(`Unexpected dependency ${token}`)
    },
  } as never)
  return { query, tx }
}

describe('payment-link completion subscriber', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('emits the declared visit update with its complete scoped payload after the write commits', async () => {
    configureHarness({
      cf_payment_link_id: payload.linkId,
      cf_payment_link_status: 'processing',
      cf_payment_received_at: null,
    })

    await onPaymentLinkCompleted(payload)

    expect(setRecordCustomFields).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityId: 'patient:patient_visit',
      recordId: visit.id,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      values: {
        payment_link_status: 'completed',
        payment_received_at: payload.occurredAt,
      },
    }))
    expect(emitPatientEvent).toHaveBeenCalledTimes(1)
    expect(emitPatientEvent).toHaveBeenCalledWith('patient.visit.updated', {
      id: visit.id,
      patientId: visit.patientId,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      updatedAt: visit.updatedAt.toISOString(),
    })
  })

  it('does not emit or rewrite an already completed visit on redelivery', async () => {
    configureHarness({
      cf_payment_link_id: payload.linkId,
      cf_payment_link_status: 'completed',
      cf_payment_received_at: payload.occurredAt,
    })

    await onPaymentLinkCompleted(payload)

    expect(setRecordCustomFields).not.toHaveBeenCalled()
    expect(emitPatientEvent).not.toHaveBeenCalled()
  })
})
