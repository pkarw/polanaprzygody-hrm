import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'
import BookingConfirmedEmail from '../emails/BookingConfirmedEmail'

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

  it('keeps jobs scalar-only, no-ops for staff visits, and marks only successful delivery', () => {
    const queue = readFileSync(path.join(__dirname, '..', 'lib', 'bookingConfirmationEmailQueue.ts'), 'utf8')
    const subscriber = readFileSync(path.join(__dirname, '..', 'subscribers', 'visit-confirmed-email.ts'), 'utf8')
    const worker = readFileSync(path.join(__dirname, '..', 'workers', 'send-email.worker.ts'), 'utf8')
    expect(queue).toContain('visitId: string')
    expect(queue).not.toContain('recipient:')
    expect(queue).not.toContain('requesterName:')
    expect(subscriber).toContain('if (!intake || intake.confirmationEmailSentAt) return')
    expect(subscriber).toContain("event: 'patient.visit.confirmed'")
    expect(worker).toContain('findOneWithDecryption(em, BookingIntake')
    expect(worker).toContain("'patient:patient_visit'")
    expect(worker).toContain('await sendEmail({')
    expect(worker.indexOf('await sendEmail({')).toBeLessThan(worker.indexOf('confirmationEmailSentAt: new Date()'))
    expect(worker).toContain('pg_advisory_xact_lock')
    expect(worker).not.toContain('logger.')
  })
})
