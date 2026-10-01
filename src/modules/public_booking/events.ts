import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  {
    id: 'public_booking.intake.submitted',
    label: 'Public booking intake submitted',
    entity: 'booking_intake',
    category: 'lifecycle',
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text' },
        { path: 'visitId', type: 'text' },
        { path: 'tenantId', type: 'text' },
        { path: 'organizationId', type: 'text' },
        { path: 'createdAt', type: 'date' },
      ],
    },
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'public_booking', events })
export const emitPublicBookingEvent = eventsConfig.emit

export default eventsConfig
