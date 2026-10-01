import { describe, expect, it } from '@jest/globals'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { assertPaymentLinkCanBeEmailed } from '../lib/visitPaymentEmailPolicy'
import VisitPaymentLinkEmail from '../emails/VisitPaymentLinkEmail'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const link = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'opaque-token',
  url: 'https://app.example.test/pay/opaque-token',
  status: 'pending' as const,
}

describe('visit payment email', () => {
  it('accepts pending/processing links and rejects inactive or completed links with 409', () => {
    expect(() => assertPaymentLinkCanBeEmailed(link)).not.toThrow()
    expect(() => assertPaymentLinkCanBeEmailed({ ...link, status: 'processing' })).not.toThrow()
    for (const status of ['inactive', 'expired', 'cancelled', 'completed'] as const) {
      try {
        assertPaymentLinkCanBeEmailed({ ...link, status })
        throw new Error('expected rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(CrudHttpError)
        expect((error as CrudHttpError).status).toBe(409)
      }
    }
  })

  it('renders only generic visit-payment copy and the opaque payment URL', () => {
    const element = VisitPaymentLinkEmail({
      paymentUrl: link.url,
      copy: {
        preview: 'Secure payment',
        heading: 'Visit payment',
        greeting: 'Hello',
        body: 'Use this link to pay.',
        cta: 'Pay',
        securityHint: 'Ignore unexpected messages.',
        footer: 'Polana Przygody',
      },
    })
    const serialized = JSON.stringify(element)
    expect(serialized).toContain(link.url)
    expect(serialized).toContain('Visit payment')
    expect(serialized).not.toContain('diagnosis')
    expect(serialized).not.toContain('description')
  })

  it('keeps queued payloads scalar-only and re-reads visit, link, and recipient in the worker', () => {
    const queue = readFileSync(path.join(__dirname, '..', 'lib', 'visitPaymentEmailQueue.ts'), 'utf8')
    const worker = readFileSync(path.join(__dirname, '..', 'workers', 'visit-payment-link-email.ts'), 'utf8')
    expect(queue).toContain('visitId: string')
    expect(queue).toContain('paymentLinkId: string')
    expect(queue).not.toContain('paymentUrl:')
    expect(queue).not.toContain('recipient:')
    expect(worker).toContain('loadCustomFieldValues({')
    expect(worker).toContain("'customers:customer_entity'")
    expect(worker).toContain("'checkout:checkout_link'")
    expect(worker).not.toContain('logger.')
  })
})
