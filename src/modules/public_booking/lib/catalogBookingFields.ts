import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'

export const PUBLIC_BOOKING_PRODUCT_FIELDSET = 'public_booking'

export const PUBLIC_BOOKING_PRODUCT_FIELDS: CustomFieldDefinition[] = [
  {
    key: 'booking_duration_minutes',
    kind: 'integer',
    label: 'Czas rezerwacji (minuty)',
    fieldset: PUBLIC_BOOKING_PRODUCT_FIELDSET,
    formEditable: true,
    filterable: true,
    indexed: true,
    validation: [{ rule: 'min', param: 1 }, { rule: 'max', param: 480 }],
  },
  {
    key: 'booking_team_member_ids',
    kind: 'relation',
    label: 'Terapeuci rezerwacji',
    fieldset: PUBLIC_BOOKING_PRODUCT_FIELDSET,
    formEditable: true,
    multi: true,
    relatedEntityId: 'staff:staff_team_member',
    optionsUrl: '/api/entities/relations/options?entityId=staff%3Astaff_team_member',
  },
  {
    key: 'booking_resource_ids',
    kind: 'relation',
    label: 'Gabinety rezerwacji',
    fieldset: PUBLIC_BOOKING_PRODUCT_FIELDSET,
    formEditable: true,
    multi: true,
    relatedEntityId: 'resources:resources_resource',
    optionsUrl: '/api/entities/relations/options?entityId=resources%3Aresources_resource',
  },
]

export const PUBLIC_BOOKING_PRODUCT_FIELD_KEYS = new Set(
  PUBLIC_BOOKING_PRODUCT_FIELDS.map((field) => field.key),
)
