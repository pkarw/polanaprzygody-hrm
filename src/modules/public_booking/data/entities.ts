import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'

/**
 * Durable audit record for one completed public-booking request.
 *
 * Every reference to an installed module is deliberately a scalar UUID. The public
 * booking module owns this record, while patient, customers and catalog keep ownership
 * of their rows and lifecycle.
 */
@Entity({ tableName: 'public_booking_intakes' })
@Index({
  name: 'public_booking_intakes_scope_submitted_idx',
  properties: ['tenantId', 'organizationId', 'submittedAt'],
})
@Index({
  name: 'public_booking_intakes_scope_visit_uq',
  expression:
    `create unique index "public_booking_intakes_scope_visit_uq" on "public_booking_intakes" ("tenant_id", "organization_id", "visit_id") where "deleted_at" is null`,
})
@Index({
  name: 'public_booking_intakes_scope_idempotency_uq',
  expression:
    `create unique index "public_booking_intakes_scope_idempotency_uq" on "public_booking_intakes" ("tenant_id", "organization_id", "client_idempotency_key")`,
})
@Check({
  name: 'public_booking_intakes_request_hash_chk',
  expression: `"request_payload_hash" ~ '^[0-9a-f]{64}$'`,
})
export class BookingIntake {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt' | 'requesterEmailSnapshot' | 'confirmationEmailSentAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'visit_id', type: 'uuid' })
  visitId!: string

  @Property({ name: 'customer_entity_id', type: 'uuid' })
  customerEntityId!: string

  @Property({ name: 'patient_id', type: 'uuid' })
  patientId!: string

  @Property({ name: 'product_id', type: 'uuid' })
  productId!: string

  /** Ciphertext; decrypted only in the confirmation-email/provenance paths. */
  @Property({ name: 'requester_name_snapshot', type: 'text' })
  requesterNameSnapshot!: string

  /** Ciphertext when present. */
  @Property({ name: 'requester_email_snapshot', type: 'text', nullable: true })
  requesterEmailSnapshot?: string | null

  /** Ciphertext. */
  @Property({ name: 'requester_phone_snapshot', type: 'text' })
  requesterPhoneSnapshot!: string

  /** Serialized consent object stored as ciphertext, never queried as JSON. */
  @Property({ name: 'consent_proof', type: 'text' })
  consentProof!: string

  @Property({ name: 'client_idempotency_key', type: 'text' })
  clientIdempotencyKey!: string

  /** SHA-256 of the canonical public request, used only for retry comparison. */
  @Property({ name: 'request_payload_hash', type: 'text' })
  requestPayloadHash!: string

  @Property({ name: 'submitted_at', type: Date })
  submittedAt!: Date

  /** Durable delivery marker; set only after the booking-confirmation email succeeds. */
  @Property({ name: 'confirmation_email_sent_at', type: Date, nullable: true })
  confirmationEmailSentAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * The one recoverable copy of the scoped public-booking API-key secret.
 *
 * The installed api_keys module owns the key/hash and auth owns the user. This table
 * keeps only scalar identifiers plus the encrypted secret required to authenticate the
 * server-side command request.
 */
@Entity({ tableName: 'public_booking_service_credentials' })
@Index({
  name: 'public_booking_service_credentials_scope_uq',
  expression:
    `create unique index "public_booking_service_credentials_scope_uq" on "public_booking_service_credentials" ("tenant_id", "organization_id") where "deleted_at" is null`,
})
export class ServiceCredential {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'service_user_id', type: 'uuid' })
  serviceUserId!: string

  @Property({ name: 'api_key_id', type: 'uuid' })
  apiKeyId!: string

  /** Ciphertext; never exposed by an API, log, event, or cache key. */
  @Property({ name: 'api_key_secret', type: 'text' })
  apiKeySecret!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
