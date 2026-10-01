import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, jest } from '@jest/globals'
import BookingConfirmedEmail from '../emails/BookingConfirmedEmail'
import {
  processBookingConfirmationDelivery,
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

function harness(initial: 'pending' | 'sending' | 'sent' | 'failed' | 'ambiguous' | null) {
  let status = initial
  const trace: string[] = []
  const logTerminal = jest.fn()
  const send = jest.fn(async () => { trace.push('provider') })
  const deps: BookingConfirmationDeliveryDependencies = {
    readStatus: async () => status,
    loadDelivery: async () => ({ ok: true, delivery: renderedDelivery }),
    claimSending: async () => {
      trace.push('claim:committed')
      if (status !== 'pending') return false
      status = 'sending'
      return true
    },
    markSent: async () => {
      trace.push('sent:committed')
      if (status !== 'sending') return false
      status = 'sent'
      return true
    },
    markFailed: async () => {
      status = 'failed'
      return true
    },
    markAmbiguous: async () => {
      status = 'ambiguous'
      trace.push('ambiguous:committed')
      return true
    },
    send,
    logTerminal,
  }
  return { deps, trace, send, logTerminal, status: () => status }
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
    expect(queue).toContain('createModuleQueue<BookingConfirmationEmailJob>')
    expect(queue).toContain('deliveryId: string')
    expect(queue).not.toContain('recipient:')
    expect(queue).not.toContain('requesterName:')
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

  it('scopes every operation-state read and transition by delivery, tenant and organization', () => {
    const worker = readFileSync(path.join(__dirname, '..', 'workers', 'send-email.worker.ts'), 'utf8')
    expect(worker).toContain('id: payload.deliveryId')
    expect(worker).toContain('tenantId: payload.tenantId')
    expect(worker).toContain('organizationId: payload.organizationId')
    expect(worker).not.toContain('pg_advisory_xact_lock')
  })

  it('logs a scope-safe terminal diagnostic when the scoped operation is absent', async () => {
    const isolated = harness(null)
    await processBookingConfirmationDelivery(isolated.deps)
    expect(isolated.send).not.toHaveBeenCalled()
    expect(isolated.logTerminal).toHaveBeenCalledWith('failed', 'delivery_missing')
  })
})
