import { describe, expect, it, jest } from '@jest/globals'
import {
  CHECKOUT_LINK_ENTITY_ID,
  CHECKOUT_LINK_VISIT_FIELDS,
  ensureVisitPaymentFieldDefinitions,
  PATIENT_VISIT_ENTITY_ID,
  PATIENT_VISIT_PAYMENT_FIELDS,
} from '../lib/visitPaymentFields'

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
}

describe('visit payment custom-field setup', () => {
  it('declares non-editable visit state and an indexed reverse checkout-link reference', () => {
    expect(PATIENT_VISIT_PAYMENT_FIELDS.map((field) => field.key)).toEqual([
      'payment_link_id',
      'payment_link_slug',
      'payment_link_status',
      'payment_received_at',
    ])
    expect(PATIENT_VISIT_PAYMENT_FIELDS.every((field) => field.formEditable === false)).toBe(true)
    expect(CHECKOUT_LINK_VISIT_FIELDS).toEqual([
      expect.objectContaining({
        key: 'patient_visit_id',
        formEditable: false,
        indexed: true,
        filterable: true,
      }),
    ])
  })

  it('is idempotent when setup runs repeatedly and keeps one definition per entity/key', async () => {
    const definitions = new Set<string>()
    const ensure = jest.fn(async (sets: Array<{ entity: string; fields: Array<{ key: string }> }>) => {
      for (const set of sets) {
        for (const field of set.fields) definitions.add(`${set.entity}:${field.key}`)
      }
    })

    await ensureVisitPaymentFieldDefinitions({ ensure: ensure as never }, scope)
    await ensureVisitPaymentFieldDefinitions({ ensure: ensure as never }, scope)

    expect(ensure).toHaveBeenCalledTimes(2)
    expect(definitions).toEqual(new Set([
      `${PATIENT_VISIT_ENTITY_ID}:payment_link_id`,
      `${PATIENT_VISIT_ENTITY_ID}:payment_link_slug`,
      `${PATIENT_VISIT_ENTITY_ID}:payment_link_status`,
      `${PATIENT_VISIT_ENTITY_ID}:payment_received_at`,
      `${CHECKOUT_LINK_ENTITY_ID}:patient_visit_id`,
    ]))
  })

  it('fails closed before invoking the installer when scope is incomplete', async () => {
    const ensure = jest.fn(async () => undefined)
    await expect(ensureVisitPaymentFieldDefinitions({ ensure }, {
      tenantId: scope.tenantId,
      organizationId: '',
    })).rejects.toThrow('tenant and organization scope')
    expect(ensure).not.toHaveBeenCalled()
  })
})
