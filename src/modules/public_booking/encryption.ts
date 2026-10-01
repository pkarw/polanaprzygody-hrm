import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

/** Sensitive requester snapshots and the service secret are always encrypted at rest. */
export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'public_booking:booking_intake',
    fields: [
      { field: 'requester_name_snapshot' },
      { field: 'requester_email_snapshot' },
      { field: 'requester_phone_snapshot' },
      { field: 'consent_proof' },
    ],
  },
  {
    entityId: 'public_booking:service_credential',
    fields: [{ field: 'api_key_secret' }],
  },
]

export default defaultEncryptionMaps
