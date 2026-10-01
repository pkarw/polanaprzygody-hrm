import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, jest } from '@jest/globals'
import BookingConfirmedEmail from '../emails/BookingConfirmedEmail'
import {
  processBookingConfirmationDelivery,
  recoverAbandonedBookingConfirmation,
  type BookingConfirmationDeliveryDependencies,
} from '../lib/bookingConfirmationEmailDelivery'

const renderedDelivery = {
  recipient: 'recipient@example.test',
  requesterName: 'Anna Kowalska',
  service: 'Diagnoza logopedyczna',
  startsAt: new Date('2026-10-05T08:00:00.000Z'),
  timeZone: 'Europe/Warsaw',
  room: 'Gabinet logopedy',
}

function harness(
  initial: 'pending' | 'sending' | 'sent' | 'failed' | 'ambiguous' | null,
  claimJobId: string | null = initial === 'sending' ? 'job-owner' : null,
  jobId = 'job-owner',
) {
  let status = initial
  let owner = claimJobId
  const trace: string[] = []
  const logTerminal = jest.fn()
  const send = jest.fn(async () => { trace.push('provider') })
  const deps: BookingConfirmationDeliveryDependencies = {
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
      status = 'ambiguous'
      trace.push('ambiguous:committed')
      return true
    },
    send,
    logTerminal,
  }
  return { deps, trace, send, logTerminal, status: () => status, owner: () => owner }
}

describe('public booking confirmation email', () => {
  it('renders only operational visit details and no clinical content', () => {
    const element = BookingConfirmedEmail({
      requesterName: 'Anna Kowalska',
      service: 'Diagnoza logopedyczna',
      date: '5 października 2026',
      time: '10:00',
      room: 'Gabinet logopedy',
      address: 'ul. Białowieska 69B, 54-234 Wrocław',
      copy: {
        preview: 'Potwierdzenie wizyty', heading: 'Wizyta potwierdzona', greeting: 'Dzień dobry',
        body: 'Termin został potwierdzony.', serviceLabel: 'Usługa', dateLabel: 'Data',
        timeLabel: 'Godzina', roomLabel: 'Gabinet', addressLabel: 'Adres', footer: 'Polana Przygody',
      },
    })
    const serialized = JSON.stringify(element)
    expect(serialized).toContain('Diagnoza logopedyczna')
    expect(serialized).toContain('Gabinet logopedy')
    expect(serialized).toContain('Białowieska 69B')
    expect(serialized).not.toContain('diagnosis')
    expect(serialized).not.toContain('description')
  })

  it('uses a process-memoized module queue and persists pending before enqueue', () => {
    const queue = readFileSync(path.join(__dirname, '..', 'lib', 'bookingConfirmationEmailQueue.ts'), 'utf8')
    const subscriber = readFileSync(path.join(__dirname, '..', 'subscribers', 'visit-confirmed-email.ts'), 'utf8')
    const producer = readFileSync(path.join(__dirname, '..', 'lib', 'bookingConfirmationEmail.ts'), 'utf8')
    expect(queue).toContain('createModuleQueue<BookingConfirmationEmailJob>')
    expect(queue).toContain('deliveryId: string')
    expect(queue).not.toContain('recipient:')
    expect(queue).not.toContain('requesterName:')
    expect(producer).not.toContain('.process(')
    expect(producer).not.toContain("../workers/send-email.worker")
    expect(readFileSync(path.join(__dirname, '..', 'workers', 'send-email.worker.ts'), 'utf8'))
      .toContain('onJobAbandoned: handleAbandonedBookingConfirmationJob')
    expect(subscriber.indexOf("confirmationEmailDeliveryStatus = 'pending'"))
      .toBeLessThan(subscriber.indexOf('await dispatchBookingConfirmationEmailJob'))
  })

  it('suppresses duplicate delivery and makes a retry after the sending claim terminal ambiguous', async () => {
    const duplicate = harness('sent')
    await processBookingConfirmationDelivery(duplicate.deps)
    expect(duplicate.send).not.toHaveBeenCalled()

    const crashed = harness('sending')
    await processBookingConfirmationDelivery(crashed.deps)
    expect(crashed.send).not.toHaveBeenCalled()
    expect(crashed.status()).toBe('ambiguous')
    expect(crashed.logTerminal).toHaveBeenCalledWith('ambiguous', 'retry_after_sending_claim')
  })

  it('does not poison an active claim when a foreign duplicate job observes it', async () => {
    const foreign = harness('sending', 'job-owner', 'job-duplicate')
    await processBookingConfirmationDelivery(foreign.deps)
    expect(foreign.send).not.toHaveBeenCalled()
    expect(foreign.status()).toBe('sending')
    expect(foreign.owner()).toBe('job-owner')
    expect(foreign.logTerminal).not.toHaveBeenCalled()
  })

  it('commits the sending claim before provider I/O and finalizes afterward', async () => {
    const delivery = harness('pending')
    await processBookingConfirmationDelivery(delivery.deps)
    expect(delivery.trace).toEqual(['claim:committed', 'provider', 'sent:committed'])
    expect(delivery.status()).toBe('sent')
  })

  it('terminalizes missing prerequisites and unknown provider acceptance with structured codes', async () => {
    const missing = harness('pending')
    missing.deps.loadDelivery = async () => ({ ok: false, code: 'recipient_missing' })
    await processBookingConfirmationDelivery(missing.deps)
    expect(missing.status()).toBe('failed')
    expect(missing.send).not.toHaveBeenCalled()
    expect(missing.logTerminal).toHaveBeenCalledWith('failed', 'recipient_missing')

    const provider = harness('pending')
    provider.deps.send = async () => { throw new TypeError('provider detail must not be logged') }
    await processBookingConfirmationDelivery(provider.deps)
    expect(provider.status()).toBe('ambiguous')
    expect(provider.logTerminal).toHaveBeenCalledWith(
      'ambiguous',
      'provider_acceptance_unknown',
      'TypeError',
    )
    expect(JSON.stringify(provider.logTerminal.mock.calls)).not.toContain('provider detail')
  })

  it('bounds provider I/O and makes timeout terminal ambiguous', async () => {
    const timedOut = harness('pending')
    timedOut.deps.providerTimeoutMs = 1
    timedOut.deps.send = () => new Promise<void>(() => undefined)
    await processBookingConfirmationDelivery(timedOut.deps)
    expect(timedOut.status()).toBe('ambiguous')
    expect(timedOut.logTerminal).toHaveBeenCalledWith(
      'ambiguous',
      'provider_timeout',
      'EmailProviderTimeoutError',
    )
  })

  it('recovers abandonment from pending or the matching sending owner only', async () => {
    const run = async (
      initial: 'pending' | 'sending' | 'sent',
      owner: string | null,
      abandonedJobId: string | null,
    ) => {
      let status: 'pending' | 'sending' | 'sent' | 'failed' | 'ambiguous' = initial
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
        logTerminal: jest.fn(),
      }
      await recoverAbandonedBookingConfirmation(abandonedJobId, deps)
      await recoverAbandonedBookingConfirmation(abandonedJobId, deps)
      return status
    }

    expect(await run('pending', null, 'job-1')).toBe('failed')
    expect(await run('sending', 'job-1', 'job-1')).toBe('ambiguous')
    expect(await run('sending', 'job-owner', 'job-foreign')).toBe('sending')
    expect(await run('sent', 'job-1', 'job-1')).toBe('sent')
  })

  it('scopes every operation-state read and transition by delivery, tenant and organization', () => {
    const worker = readFileSync(path.join(__dirname, '..', 'workers', 'send-email.worker.ts'), 'utf8')
    expect(worker).toContain('id: payload.deliveryId')
    expect(worker).toContain('tenantId: payload.tenantId')
    expect(worker).toContain('organizationId: payload.organizationId')
    expect(worker).toContain('confirmationEmailClaimJobId: expectedClaimJobId')
    expect(worker).toContain('confirmationEmailClaimJobId: nextClaimJobId')
    expect(worker).not.toContain('pg_advisory_xact_lock')
  })

  it('keeps the ownership column additive and the approved spec traceable', () => {
    const migration = readFileSync(path.join(
      __dirname, '..', 'migrations', 'Migration20261001194830_public_booking.ts',
    ), 'utf8')
    const spec = readFileSync(path.join(
      __dirname, '..', '..', '..', '..', '.ai', 'specs', '2026-10-01-public-visit-booking-website.md',
    ), 'utf8')
    expect(migration).toContain('add "confirmation_email_claim_job_id" text null')
    expect(migration).not.toContain('alter column')
    expect(spec).toContain('process-memoized `createModuleQueue`')
    expect(spec).toContain('claimJobId')
    expect(spec).toContain('onJobAbandoned')
    expect(spec).toContain('provider timeout')
  })

  it('logs a scope-safe terminal diagnostic when the scoped operation is absent', async () => {
    const isolated = harness(null)
    await processBookingConfirmationDelivery(isolated.deps)
    expect(isolated.send).not.toHaveBeenCalled()
    expect(isolated.logTerminal).toHaveBeenCalledWith('failed', 'delivery_missing')
  })
})
