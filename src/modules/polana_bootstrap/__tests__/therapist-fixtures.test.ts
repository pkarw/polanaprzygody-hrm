import { describe, expect, it } from '@jest/globals'
import {
  POLANA_THERAPISTS,
  POLANA_THERAPISTS_CAPTURED_AT,
  POLANA_THERAPISTS_SOURCE_URL,
} from '../lib/therapistFixtures'

describe('Polana therapist snapshot', () => {
  it('preserves every published therapist and every profile field', () => {
    expect(POLANA_THERAPISTS_CAPTURED_AT).toBe('2026-09-28')
    expect(POLANA_THERAPISTS_SOURCE_URL).toBe('https://polanaprzygody.pl/terapeuci')
    expect(POLANA_THERAPISTS.map((therapist) => therapist.sourceId)).toEqual([
      'katarzyna-karwatka',
      'weronika-saczewska',
      'magdalena-wawrzycka',
      'anna-kuczkowska-pluta',
    ])
    for (const therapist of POLANA_THERAPISTS) {
      expect(therapist).toEqual(expect.objectContaining({
        displayName: expect.any(String),
        experience: expect.any(String),
        photoUrl: expect.stringMatching(/^https:\/\/polanaprzygody\.pl\/images\/terapeuci\//),
        shortDescription: expect.any(String),
        fullDescription: expect.any(String),
        quote: expect.any(String),
        bookingUrl: expect.stringMatching(/^https:\/\/polanaprzygody\.pl\/umow-sie\?/),
      }))
      expect(therapist.roles.length).toBeGreaterThan(0)
      expect(therapist.specializations.length).toBeGreaterThan(0)
    }
  })
})
