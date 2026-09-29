import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Typed events emitted by the `patient` module.
 *
 * Two rules from the spec ("Events, Jobs, Notifications, and Cross-Module Flows")
 * shape every entry below, and both are about what is NOT here:
 *
 * 1. **The payload carries identifiers and scope only** — `{id, tenantId,
 *    organizationId, patientId?, updatedAt}`. No names, no free text, no diagnosis
 *    titles or codes, no document titles, no file names. A subscriber is not
 *    authorized to read the record just because it received the event, so putting
 *    content on the wire would hand it data its own ACL would have refused.
 * 2. **No `clientBroadcast` / `portalBroadcast`.** Both flags fan an event out to
 *    browser or portal listeners, filtered by scope but not by feature. Anyone
 *    holding any backoffice session in the organization would learn that a patient
 *    record changed and, from the id, that the person is a patient at all — which is
 *    exactly the "korzystanie z opieki" disclosure the spec forbids.
 *
 * Emission is post-commit and happens in exactly one layer (the command), never
 * also in the route.
 */
const events = [
  { id: 'patient.patient.created', label: 'Patient Created', entity: 'patient', category: 'crud' },
  { id: 'patient.patient.updated', label: 'Patient Updated', entity: 'patient', category: 'crud' },
  { id: 'patient.patient.archived', label: 'Patient Archived', entity: 'patient', category: 'lifecycle' },
  { id: 'patient.patient.restored', label: 'Patient Restored', entity: 'patient', category: 'lifecycle' },
  { id: 'patient.patient.deleted', label: 'Patient Deleted', entity: 'patient', category: 'crud' },

  { id: 'patient.address.created', label: 'Patient Address Created', entity: 'address', category: 'crud' },
  { id: 'patient.address.updated', label: 'Patient Address Updated', entity: 'address', category: 'crud' },
  { id: 'patient.address.deleted', label: 'Patient Address Deleted', entity: 'address', category: 'crud' },

  { id: 'patient.contact.created', label: 'Patient Contact Linked', entity: 'contact', category: 'crud' },
  { id: 'patient.contact.updated', label: 'Patient Contact Updated', entity: 'contact', category: 'crud' },
  { id: 'patient.contact.deleted', label: 'Patient Contact Unlinked', entity: 'contact', category: 'crud' },

  { id: 'patient.diagnosis.created', label: 'Diagnosis Created', entity: 'diagnosis', category: 'crud' },
  { id: 'patient.diagnosis.corrected', label: 'Diagnosis Corrected', entity: 'diagnosis', category: 'lifecycle' },
  { id: 'patient.diagnosis.voided', label: 'Diagnosis Voided', entity: 'diagnosis', category: 'lifecycle' },

  { id: 'patient.document_link.created', label: 'Document Link Created', entity: 'document_link', category: 'crud' },
  { id: 'patient.document_link.updated', label: 'Document Link Updated', entity: 'document_link', category: 'crud' },
  { id: 'patient.document_link.deleted', label: 'Document Link Deleted', entity: 'document_link', category: 'crud' },

  { id: 'patient.attachment_link.created', label: 'Attachment Link Created', entity: 'attachment_link', category: 'crud' },
  { id: 'patient.attachment_link.deleted', label: 'Attachment Link Deleted', entity: 'attachment_link', category: 'crud' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'patient',
  events,
})

/** Type-safe emitter for this module's events. */
export const emitPatientEvent = eventsConfig.emit

/** Event ids this module may emit. */
export type PatientEventId = typeof events[number]['id']

export default eventsConfig
