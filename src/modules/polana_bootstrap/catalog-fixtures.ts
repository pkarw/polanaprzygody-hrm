export const POLANA_CATALOG_SOURCE_URL = 'https://polanaprzygody.pl/cennik'
export const POLANA_CATALOG_CAPTURED_AT = '2026-09-28'

export type PolanaCatalogFixture = {
  sku: string
  title: string
  category: 'Diagnozy' | 'Terapie' | 'Zajęcia grupowe' | 'Konsultacje'
  description: string | null
  pricePln: number
  customFields: Record<string, string | number>
}

export const POLANA_CATALOG_FIXTURES: readonly PolanaCatalogFixture[] = [
  {
    sku: 'PP-DIAG-SI',
    title: 'Diagnoza integracji sensorycznej',
    category: 'Diagnozy',
    description: '4 spotkania: wywiad z rodzicem, dwa spotkania z dzieckiem, omówienie diagnozy z rodzicem',
    pricePln: 750,
    customFields: { session_details: '4 spotkania: wywiad z rodzicem, dwa spotkania z dzieckiem, omówienie diagnozy z rodzicem' },
  },
  {
    sku: 'PP-DIAG-LOG',
    title: 'Diagnoza logopedyczna',
    category: 'Diagnozy',
    description: '2 spotkania: 1 z rodzicem, drugie z dzieckiem. Wariant z pisemnym raportem z diagnozy (opinia logopedyczna): dodatkowo płatny 150 zł',
    pricePln: 300,
    customFields: {
      session_details: '2 spotkania: 1 z rodzicem, drugie z dzieckiem.',
      surcharge_amount_pln: 150,
      pricing_note: 'Wariant z pisemnym raportem z diagnozy (opinia logopedyczna): dodatkowo płatny 150 zł',
    },
  },
  {
    sku: 'PP-DIAG-PSY',
    title: 'Diagnoza psychologiczna',
    category: 'Diagnozy',
    description: 'w zależności od zakresu diagnozy i ilości spotkań',
    pricePln: 700,
    customFields: { price_max_pln: 1000, pricing_note: 'w zależności od zakresu diagnozy i ilości spotkań' },
  },
  { sku: 'PP-TER-LOG', title: 'Terapia logopedyczna', category: 'Terapie', description: null, pricePln: 200, customFields: {} },
  { sku: 'PP-REDIAG-LOG', title: 'Rediagnoza logopedyczna', category: 'Diagnozy', description: null, pricePln: 200, customFields: {} },
  { sku: 'PP-TER-SI', title: 'Terapia SI', category: 'Terapie', description: null, pricePln: 200, customFields: {} },
  {
    sku: 'PP-TUS',
    title: 'Trening Umiejętności Społecznych (TUS)',
    category: 'Zajęcia grupowe',
    description: '60 minut, zajęcia grupowe',
    pricePln: 120,
    customFields: { session_details: '60 minut, zajęcia grupowe' },
  },
  { sku: 'PP-KONS-PSY', title: 'Konsultacja psychologa', category: 'Konsultacje', description: null, pricePln: 220, customFields: {} },
] as const
