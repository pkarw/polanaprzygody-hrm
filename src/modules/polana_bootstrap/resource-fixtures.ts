import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'

/**
 * Polana Przygody owns its own resource fieldset instead of reusing the core
 * `resources_resource_room` example set: the gabinets need a postal address and
 * therapy metadata that the generic room set does not carry.
 */
export const POLANA_ROOM_FIELDSET = 'polana_therapy_room'

export const POLANA_ROOM_FIELDSET_DEFINITION = {
  code: POLANA_ROOM_FIELDSET,
  label: 'Gabinet Polany Przygody',
  description: 'Adres, wyposażenie i dostępność gabinetów terapeutycznych.',
  groups: [
    { code: 'address', title: 'Adres' },
    { code: 'location', title: 'Lokalizacja' },
    { code: 'equipment', title: 'Wyposażenie' },
    { code: 'access', title: 'Dostępność' },
  ],
} as const

export const POLANA_ROOM_FIELDS: CustomFieldDefinition[] = [
  { key: 'polana_resource_key', kind: 'text', label: 'Klucz zasobu Polany', formEditable: false, indexed: true, fieldset: POLANA_ROOM_FIELDSET },
  { key: 'polana_room_address_street', kind: 'text', label: 'Ulica i numer', formEditable: true, filterable: true, indexed: true, listVisible: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'address' } },
  { key: 'polana_room_address_postal_code', kind: 'text', label: 'Kod pocztowy', formEditable: true, filterable: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'address' } },
  { key: 'polana_room_address_city', kind: 'text', label: 'Miasto', formEditable: true, filterable: true, indexed: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'address' } },
  { key: 'polana_room_address_country', kind: 'text', label: 'Kraj', formEditable: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'address' } },
  { key: 'polana_room_floor', kind: 'text', label: 'Piętro', formEditable: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'location' } },
  { key: 'polana_room_area_sqm', kind: 'float', label: 'Powierzchnia (m²)', formEditable: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'location' } },
  { key: 'polana_room_therapy_types', kind: 'text', multi: true, input: 'tags', label: 'Rodzaje terapii', formEditable: true, filterable: true, indexed: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'equipment' } },
  { key: 'polana_room_equipment', kind: 'multiline', editor: 'simpleMarkdown', label: 'Wyposażenie', formEditable: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'equipment' } },
  { key: 'polana_room_wheelchair_accessible', kind: 'boolean', label: 'Dostępny dla wózków', formEditable: true, filterable: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'access' } },
  { key: 'polana_room_access_notes', kind: 'multiline', label: 'Uwagi o dostępie', formEditable: true, fieldset: POLANA_ROOM_FIELDSET, group: { code: 'access' } },
]

export function isPolanaRoomFieldKey(key: string): boolean {
  return POLANA_ROOM_FIELDS.some((field) => field.key === key)
}

/** Every gabinet shares one street address, so it lives here once. */
export const POLANA_ROOM_ADDRESS = {
  street: 'ul. Białowieska 69B',
  postalCode: '54-234',
  city: 'Wrocław',
  country: 'Polska',
} as const

export const POLANA_AVAILABILITY_TIMEZONE = 'Europe/Warsaw'
export const POLANA_AVAILABILITY_OPENS_AT = '09:00'
export const POLANA_AVAILABILITY_CLOSES_AT = '19:00'

export const POLANA_AVAILABILITY_RULE_SET = {
  name: 'Gabinety Polany Przygody 9:00–19:00',
  description: 'Gabinety i sale dostępne codziennie od 09:00 do 19:00.',
  timezone: POLANA_AVAILABILITY_TIMEZONE,
} as const

/** Weekday indexes follow `Date#getDay()`: 0 = niedziela … 6 = sobota. */
export const POLANA_AVAILABILITY_WINDOWS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  start: POLANA_AVAILABILITY_OPENS_AT,
  end: POLANA_AVAILABILITY_CLOSES_AT,
}))

export const POLANA_CAPACITY_UNIT = { value: 'osoby', label: 'Osoby' } as const

/**
 * The core `resources` module seeds an office-supplies example set on every
 * install. Polana Przygody runs a therapy centre, so the whole example set is
 * removed before the real gabinets are created.
 */
export const LEGACY_RESOURCE_NAMES = [
  'Meeting Room A',
  'Meeting Room B',
  'Focus Room 1',
  'Focus Room 2',
  'Engineering Laptop 1',
  'Engineering Laptop 2',
  'Tesla Model 3 - WWA 4K32',
  'Volvo XC40 Recharge - WPR 9L18',
] as const

export const LEGACY_RESOURCE_TYPE_NAMES = [
  'Meeting room',
  'Focus room',
  'Engineering laptop',
  'Company car',
] as const

export const LEGACY_RESOURCE_TAG_SLUGS = [
  'room',
  'focus',
  'tech',
  'equipment',
  'vehicle',
  'collaboration',
] as const

export type PolanaResourceTypeFixture = {
  key: string
  name: string
  description: string
  appearanceIcon: string
  appearanceColor: string
}

export const POLANA_RESOURCE_TYPES: PolanaResourceTypeFixture[] = [
  {
    key: 'gabinet',
    name: 'Gabinet terapeutyczny',
    description: 'Gabinet do zajęć indywidualnych z jednym terapeutą.',
    appearanceIcon: 'lucide:door-closed',
    appearanceColor: '#0f766e',
  },
  {
    key: 'sala',
    name: 'Sala terapeutyczna',
    description: 'Sala do zajęć ruchowych i grupowych.',
    appearanceIcon: 'lucide:layout-grid',
    appearanceColor: '#7c3aed',
  },
]

export type PolanaResourceTagFixture = {
  key: string
  slug: string
  label: string
  color: string
}

export const POLANA_RESOURCE_TAGS: PolanaResourceTagFixture[] = [
  { key: 'terapia', slug: 'terapia', label: 'Terapia', color: '#0f766e' },
  { key: 'psychologia', slug: 'psychologia', label: 'Psychologia', color: '#2563eb' },
  { key: 'logopedia', slug: 'logopedia', label: 'Logopedia', color: '#db2777' },
  { key: 'neurologopedia', slug: 'neurologopedia', label: 'Neurologopedia', color: '#7c3aed' },
  { key: 'integracja-sensoryczna', slug: 'integracja-sensoryczna', label: 'Integracja sensoryczna', color: '#f59e0b' },
]

export type PolanaResourceFixture = {
  key: string
  name: string
  description: string
  typeKey: string
  tagKeys: string[]
  capacity: number
  appearanceIcon: string
  appearanceColor: string
  customFields: {
    polana_room_floor: string
    polana_room_area_sqm: number
    polana_room_therapy_types: string[]
    polana_room_equipment: string
    polana_room_wheelchair_accessible: boolean
    polana_room_access_notes: string
  }
}

export const POLANA_RESOURCES: PolanaResourceFixture[] = [
  {
    key: 'gabinet-psychologa',
    name: 'Gabinet Psychologa',
    description: 'Gabinet konsultacji, diagnozy i terapii psychologicznej.',
    typeKey: 'gabinet',
    tagKeys: ['terapia', 'psychologia'],
    capacity: 3,
    appearanceIcon: 'lucide:brain',
    appearanceColor: '#2563eb',
    customFields: {
      polana_room_floor: 'Parter',
      polana_room_area_sqm: 16,
      polana_room_therapy_types: [
        'Diagnoza psychologiczna',
        'Terapia indywidualna',
        'Konsultacje dla rodziców',
      ],
      polana_room_equipment: 'Fotele terapeutyczne, biurko, testy psychologiczne, materiały do terapii poznawczej.',
      polana_room_wheelchair_accessible: true,
      polana_room_access_notes: 'Wejście od strony parkingu, gabinet po prawej stronie korytarza.',
    },
  },
  {
    key: 'gabinet-logopedy',
    name: 'Gabinet Logopedy',
    description: 'Gabinet terapii logopedycznej i ćwiczeń artykulacyjnych.',
    typeKey: 'gabinet',
    tagKeys: ['terapia', 'logopedia'],
    capacity: 3,
    appearanceIcon: 'lucide:message-circle',
    appearanceColor: '#db2777',
    customFields: {
      polana_room_floor: 'Parter',
      polana_room_area_sqm: 14,
      polana_room_therapy_types: [
        'Diagnoza logopedyczna',
        'Terapia artykulacji',
        'Terapia opóźnionego rozwoju mowy',
      ],
      polana_room_equipment: 'Lustro logopedyczne, zestaw sond, gry i karty obrazkowe, stolik terapeutyczny.',
      polana_room_wheelchair_accessible: true,
      polana_room_access_notes: 'Gabinet obok poczekalni, drzwi oznaczone piktogramem mowy.',
    },
  },
  {
    key: 'gabinet-neurologopedii',
    name: 'Gabinet Neurologopedii',
    description: 'Gabinet diagnozy i terapii neurologopedycznej, w tym karmienia i funkcji oralnych.',
    typeKey: 'gabinet',
    tagKeys: ['terapia', 'neurologopedia'],
    capacity: 3,
    appearanceIcon: 'lucide:activity',
    appearanceColor: '#7c3aed',
    customFields: {
      polana_room_floor: 'Parter',
      polana_room_area_sqm: 14,
      polana_room_therapy_types: [
        'Diagnoza neurologopedyczna',
        'Terapia miofunkcjonalna',
        'Terapia karmienia',
      ],
      polana_room_equipment: 'Leżanka, lustro, zestaw do terapii miofunkcjonalnej, elektrostymulator logopedyczny.',
      polana_room_wheelchair_accessible: true,
      polana_room_access_notes: 'Gabinet na końcu korytarza, obok gabinetu logopedy.',
    },
  },
  {
    key: 'sala-si',
    name: 'Sala do ćwiczeń SI',
    description: 'Sala do terapii integracji sensorycznej z podwieszanym sprzętem.',
    typeKey: 'sala',
    tagKeys: ['terapia', 'integracja-sensoryczna'],
    capacity: 6,
    appearanceIcon: 'lucide:layout-grid',
    appearanceColor: '#f59e0b',
    customFields: {
      polana_room_floor: 'Parter',
      polana_room_area_sqm: 42,
      polana_room_therapy_types: [
        'Diagnoza integracji sensorycznej',
        'Terapia integracji sensorycznej',
        'Zajęcia ruchowe grupowe',
      ],
      polana_room_equipment: 'Podwieszany sprzęt SI (huśtawki, hamak, platforma), materace, deskorolka, tunel, ścianka wspinaczkowa.',
      polana_room_wheelchair_accessible: true,
      polana_room_access_notes: 'Największe pomieszczenie, wejście bezpośrednio z holu; obuwie zmienne obowiązkowe.',
    },
  },
]
