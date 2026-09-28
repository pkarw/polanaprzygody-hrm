export type PolanaPersonFixture = {
  email: string
  firstName: string
  lastName: string
  address: {
    addressLine1: string
    city: 'Wrocław'
    postalCode: string
    country: 'PL'
  }
}

export const POLANA_PERSON_FIXTURES: readonly PolanaPersonFixture[] = [
  ['pp-klient-01@example.invalid', 'Anna', 'Wiosenna', 'Bajkowa 12/3', '50-001'],
  ['pp-klient-02@example.invalid', 'Michał', 'Dobrowolski', 'Słoneczna 8/5', '50-002'],
  ['pp-klient-03@example.invalid', 'Katarzyna', 'Zielińska', 'Przygodna 21/7', '50-003'],
  ['pp-klient-04@example.invalid', 'Tomasz', 'Leśny', 'Radosna 4/2', '50-004'],
  ['pp-klient-05@example.invalid', 'Natalia', 'Kwiatkowska', 'Wesoła 33/6', '50-005'],
  ['pp-klient-06@example.invalid', 'Piotr', 'Sowiński', 'Spacerowa 17/1', '50-006'],
  ['pp-klient-07@example.invalid', 'Joanna', 'Borkowska', 'Polankowa 9/4', '50-007'],
  ['pp-klient-08@example.invalid', 'Marcin', 'Lipiński', 'Tęczowa 26/8', '50-008'],
  ['pp-klient-09@example.invalid', 'Aleksandra', 'Brzozowska', 'Pogodna 15/9', '50-009'],
  ['pp-klient-10@example.invalid', 'Krzysztof', 'Majewski', 'Rodzinna 30/10', '50-010'],
].map(([email, firstName, lastName, addressLine1, postalCode]) => ({
  email,
  firstName,
  lastName,
  address: { addressLine1, city: 'Wrocław', postalCode, country: 'PL' },
}))
