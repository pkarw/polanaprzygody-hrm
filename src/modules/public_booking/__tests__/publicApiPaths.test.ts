import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'

const routes = [
  ['api/public/booking/services/route.ts', "path: '/public/booking/services'", 'requireAuth: false'],
  ['api/public/booking/services/[id]/therapists/route.ts', "path: '/public/booking/services/[id]/therapists'", 'requireAuth: false'],
  ['api/public/booking/availability/route.ts', "path: '/public/booking/availability'", 'requireAuth: false'],
  ['api/public/booking/requests/route.ts', "path: '/public/booking/requests'", 'requireAuth: false'],
  ['api/public-booking/visits/[id]/provenance/route.ts', "path: '/public-booking/visits/[id]/provenance'", "requireFeatures: ['patient.visits.view']"],
] as const

describe('public booking API paths', () => {
  it.each(routes)('mounts %s at the stable browser-facing path', (relativePath, expectedPath, authContract) => {
    const source = readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
    expect(source).toContain(expectedPath)
    expect(source).toContain(authContract)
  })

  it('keeps frontend calls aligned with the mounted contracts', () => {
    const wizard = readFileSync(path.join(__dirname, '..', 'frontend/components/BookingWizard.tsx'), 'utf8')
    const pricing = readFileSync(path.join(__dirname, '..', 'frontend/components/PricingPage.tsx'), 'utf8')
    const provenance = readFileSync(path.join(__dirname, '..', '..', 'patient/components/OnlineBookingProvenance.tsx'), 'utf8')
    expect(wizard).toContain("'/api/public/booking/services'")
    expect(wizard).toContain("'/api/public/booking/requests'")
    expect(pricing).toContain("'/api/public/booking/services'")
    expect(provenance).toContain('/api/public-booking/visits/')
  })
})
