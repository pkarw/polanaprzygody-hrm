import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, jest } from '@jest/globals'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import VisitPaymentLinkEmail from '../emails/VisitPaymentLinkEmail'
import {
  dispatchDurablePaymentEmailOperation,
  type DurablePaymentEmailDispatchDependencies,
} from '../lib/visitPaymentEmailOperation'
import { assertPaymentLinkCanBeEmailed } from '../lib/visitPaymentEmailPolicy'
import {
  processVisitPaymentEmailDelivery,
  recoverAbandonedVisitPaymentEmail,
  type VisitPaymentEmailDeliveryDependencies,
} from '../lib/visitPaymentEmailDelivery'

const link = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'opaque-token',
  url: 'https://app.example.test/pay/opaque-token',
  status: 'pending' as const,
}

const renderedDelivery = {
  recipient: 'patient@example.test',
  paymentUrl: link.url,
}

function workerHarness(
  initial: 'pending' | 'sending' | 'sent' | 'failed' | 'ambiguous' | null,
  claimJobId: string | null = initial === 'sending' ? 'job-owner' : null,
  jobId = 'job-owner',
) {
  let status = initial
  let owner = claimJobId
  const trace: string[] = []
  const logTerminal = jest.fn()
  const send = jest.fn(async () => { trace.push('provider') })
  const deps: VisitPaymentEmailDeliveryDependencies = {
    jobId,
    readState: async () => status ? { status, claimJobId: owner } : null,
    loadDelivery: async () => ({ ok: true, delivery: renderedDelivery }),
    claimSending: async (nextJobId) => {
      trace.push('claim:committed')
      if (status !== 'pending') return false
      status = 'sending'
      owner = nextJobId
      return true
    },
    markSent: async (expectedJobId) => {
      trace.push('sent:committed')
      if (status !== 'sending' || owner !== expectedJobId) return false
      status = 'sent'
      return true
    },
    markFailed: async () => {
      status = 'failed'
      return true
    },
    markAmbiguous: async (expectedJobId) => {
      if (status !== 'sending' || owner !== expectedJobId) return false
      trace.push('ambiguous:committed')
      status = 'ambiguous'
      return true
    },
    send,
    logTerminal,
  }
  return { deps, trace, send, logTerminal, status: () => status, owner: () => owner }
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

  it('uses a process-memoized module queue with a scalar stable operation id', () => {
    const queue = readFileSync(path.join(__dirname, '..', 'lib', 'visitPaymentEmailQueue.ts'), 'utf8')
    const producer = readFileSync(path.join(__dirname, '..', 'lib', 'visitPaymentEmail.ts'), 'utf8')
    const worker = readFileSync(path.join(__dirname, '..', 'workers', 'visit-payment-link-email.ts'), 'utf8')
    expect(queue).toContain('createModuleQueue<VisitPaymentEmailJob>')
    expect(queue).toContain('deliveryId: string')
    expect(queue).not.toContain('paymentUrl:')
    expect(queue).not.toContain('recipient:')
    expect(producer).not.toContain('.process(')
    expect(producer).not.toContain("../workers/visit-payment-link-email")
    expect(worker).toContain('loadCustomFieldValues({')
    expect(worker).toContain("'customers:customer_entity'")
    expect(worker).toContain("'checkout:checkout_link'")
    expect(worker).toContain('onJobAbandoned: handleAbandonedVisitPaymentEmailJob')
  })

  it('suppresses terminal duplicates and terminalizes a same-job restart without sending', async () => {
    const duplicate = workerHarness('sent')
    await processVisitPaymentEmailDelivery(duplicate.deps)
    expect(duplicate.send).not.toHaveBeenCalled()

    const crashed = workerHarness('sending')
    await processVisitPaymentEmailDelivery(crashed.deps)
    expect(crashed.send).not.toHaveBeenCalled()
    expect(crashed.status()).toBe('ambiguous')
    expect(crashed.logTerminal).toHaveBeenCalledWith('ambiguous', 'retry_after_sending_claim')
  })

  it('leaves an in-flight claim untouched when a different job sees it', async () => {
    const foreign = workerHarness('sending', 'job-owner', 'job-duplicate')
    await processVisitPaymentEmailDelivery(foreign.deps)
    expect(foreign.send).not.toHaveBeenCalled()
    expect(foreign.status()).toBe('sending')
    expect(foreign.owner()).toBe('job-owner')
    expect(foreign.logTerminal).not.toHaveBeenCalled()
  })

  it('commits the sending claim before provider I/O and terminalizes provider uncertainty', async () => {
    const success = workerHarness('pending')
    await processVisitPaymentEmailDelivery(success.deps)
    expect(success.trace).toEqual(['claim:committed', 'provider', 'sent:committed'])

    const provider = workerHarness('pending')
    provider.deps.send = async () => { throw new TypeError('secret provider detail') }
    await processVisitPaymentEmailDelivery(provider.deps)
    expect(provider.status()).toBe('ambiguous')
    expect(provider.logTerminal).toHaveBeenCalledWith(
      'ambiguous',
      'provider_acceptance_unknown',
      'TypeError',
    )
    expect(JSON.stringify(provider.logTerminal.mock.calls)).not.toContain('secret provider detail')
  })

  it('marks missing prerequisites failed without calling the provider', async () => {
    const missing = workerHarness('pending')
    missing.deps.loadDelivery = async () => ({ ok: false, code: 'recipient_missing' })
    await processVisitPaymentEmailDelivery(missing.deps)
    expect(missing.status()).toBe('failed')
    expect(missing.send).not.toHaveBeenCalled()
    expect(missing.logTerminal).toHaveBeenCalledWith('failed', 'recipient_missing')
  })

  it('bounds provider I/O and makes timeout terminal ambiguous', async () => {
    const timedOut = workerHarness('pending')
    timedOut.deps.providerTimeoutMs = 1
    timedOut.deps.send = () => new Promise<void>(() => undefined)
    await processVisitPaymentEmailDelivery(timedOut.deps)
    expect(timedOut.status()).toBe('ambiguous')
    expect(timedOut.logTerminal).toHaveBeenCalledWith(
      'ambiguous',
      'provider_timeout',
      'EmailProviderTimeoutError',
    )
  })

  it('recovers abandoned jobs idempotently without overwriting foreign or terminal state', async () => {
    const run = async (
      initial: 'pending' | 'sending' | 'sent',
      owner: string | null,
      abandonedJobId: string | null,
    ) => {
      let status: 'pending' | 'sending' | 'sent' | 'failed' | 'ambiguous' = initial
      const logTerminal = jest.fn()
      const deps = {
        markPendingFailed: async () => {
          if (status !== 'pending') return false
          status = 'failed'
          return true
        },
        markOwnedSendingAmbiguous: async (jobId: string) => {
          if (status !== 'sending' || owner !== jobId) return false
          status = 'ambiguous'
          return true
        },
        logTerminal,
      }
      await recoverAbandonedVisitPaymentEmail(abandonedJobId, deps)
      await recoverAbandonedVisitPaymentEmail(abandonedJobId, deps)
      return { status, logTerminal }
    }

    expect((await run('pending', null, 'job-1')).status).toBe('failed')
    expect((await run('sending', 'job-1', 'job-1')).status).toBe('ambiguous')
    expect((await run('sending', 'job-owner', 'job-foreign')).status).toBe('sending')
    expect((await run('sent', 'job-1', 'job-1')).status).toBe('sent')
  })

  it('keeps pending recoverable after enqueue failure, isolates scope, and allows intentional resend', async () => {
    type Operation = {
      id: string
      visitId: string
      paymentLinkId: string
      status: 'pending'
    }
    const operations = new Map<string, Operation>()
    const queued: string[] = []
    let sequence = 0
    let failNextEnqueue = true

    const run = async (scope: { tenantId: string; organizationId: string }, operationKey: string) => {
      const mapKey = `${scope.tenantId}:${scope.organizationId}:${operationKey}`
      const deps: DurablePaymentEmailDispatchDependencies = {
        findOrCreate: async () => {
          const existing = operations.get(mapKey)
          if (existing) return existing
          const created: Operation = {
            id: `delivery-${++sequence}`,
            visitId: 'visit-1',
            paymentLinkId: link.id,
            status: 'pending',
          }
          operations.set(mapKey, created)
          return created
        },
        enqueue: async (payload) => {
          if (failNextEnqueue) {
            failNextEnqueue = false
            throw new Error('queue unavailable')
          }
          queued.push(payload.deliveryId)
        },
        reject: async (code) => { throw new Error(code) },
      }
      await dispatchDurablePaymentEmailOperation({
        visitId: 'visit-1',
        paymentLinkId: link.id,
        ...scope,
      }, deps)
    }

    const scopeA = { tenantId: 'tenant-1', organizationId: 'org-1' }
    await expect(run(scopeA, 'same-http-attempt')).rejects.toThrow('queue unavailable')
    expect(operations.size).toBe(1)
    await run(scopeA, 'same-http-attempt')
    expect(queued).toEqual(['delivery-1'])

    await run(scopeA, 'intentional-resend')
    expect(queued).toEqual(['delivery-1', 'delivery-2'])

    await run({ tenantId: 'tenant-1', organizationId: 'org-2' }, 'same-http-attempt')
    expect(queued).toEqual(['delivery-1', 'delivery-2', 'delivery-3'])
    expect(operations.size).toBe(3)
  })

  it('scopes every operation-state read and transition by delivery, tenant and organization', () => {
    const worker = readFileSync(path.join(__dirname, '..', 'workers', 'visit-payment-link-email.ts'), 'utf8')
    expect(worker).toContain('id: payload.deliveryId')
    expect(worker).toContain('tenantId: payload.tenantId')
    expect(worker).toContain('organizationId: payload.organizationId')
    expect(worker).toContain('claimJobId: expectedClaimJobId')
    expect(worker).toContain('claimJobId: nextClaimJobId')
  })

  it('keeps the ownership column additive and the approved spec traceable', () => {
    const migration = readFileSync(path.join(
      __dirname, '..', 'migrations', 'Migration20261001194830_patient.ts',
    ), 'utf8')
    const spec = readFileSync(path.join(
      __dirname, '..', '..', '..', '..', '.ai', 'specs', '2026-10-01-visit-payment-links.md',
    ), 'utf8')
    expect(migration).toContain('add "claim_job_id" text null')
    expect(migration).not.toContain('alter column')
    expect(spec).toContain('enqueue-only producer')
    expect(spec).toContain('claimJobId')
    expect(spec).toContain('onJobAbandoned')
    expect(spec).toContain('intentional resend')
  })

  it('logs a scope-safe terminal diagnostic when the scoped operation is absent', async () => {
    const isolated = workerHarness(null)
    await processVisitPaymentEmailDelivery(isolated.deps)
    expect(isolated.send).not.toHaveBeenCalled()
    expect(isolated.logTerminal).toHaveBeenCalledWith('failed', 'delivery_missing')
  })
})
