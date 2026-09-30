import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'

/**
 * Entities for the `patient` module (spec PAT, "Data Models").
 *
 * Three conventions hold across every table below, and each one is load-bearing:
 *
 * 1. **`(tenant_id, organization_id)` leads every index**, and both columns are
 *    `NOT NULL`. The spec has no global patients: a nullable scope column would make
 *    "no organization" indistinguishable from "every organization" on a read, which is
 *    the fail-open the spec forbids.
 * 2. **No cross-module FK or ORM relation.** `customer_entity_id`,
 *    `owner_team_member_id`, `document_id` and `attachment_id` are plain `uuid`
 *    scalars resolved through their owners' APIs. That is why deleting a CRM person or
 *    a staff member cannot cascade into clinical history — and why a read has to cope
 *    with a reference that no longer resolves.
 * 3. **Soft delete only.** `deleted_at` is the tombstone and every partial unique index
 *    is scoped `where deleted_at is null`, so unlinking a contact and re-linking the
 *    same person later is legal while two simultaneous active links are not. Voiding a
 *    diagnosis is a status transition, never a `deleted_at` write.
 *
 * Encrypted columns are declared in `../encryption.ts`. Every one of them is `text`,
 * including `birth_date`: a column holding ciphertext cannot be a SQL `date`, and the
 * spec calls that out explicitly. The consequence is that no encrypted column may be
 * sorted on or matched with `ilike` in SQL — the read paths use hashed exact-match
 * indexes instead.
 */

export type PatientStatus = 'active' | 'archived'
export type PatientDiagnosisStatus = 'active' | 'superseded' | 'voided'
export type PatientDocumentLinkState = 'pending_create' | 'linked' | 'abandoned'
export type PatientAttachmentLinkState = 'active' | 'detached'
export type PatientVisitStatus = 'planned' | 'completed' | 'cancelled' | 'no_show'

/**
 * The patient record — `patient:patient`.
 *
 * `patient_number` is the non-clinical, server-assigned, immutable handle. It is
 * `P-<uuid>` on purpose: a sequential counter would need a global lock to stay gapless
 * and would leak how many patients the organization has. It is NOT a national id — the
 * spec lists PESEL-as-identifier as an explicit non-goal.
 *
 * `client_request_id` + `create_request_payload` are the idempotency pair. The payload
 * is the normalized original create request, encrypted, never returned by the API and
 * never logged; it exists so a retry can be compared against what was first submitted
 * rather than against the record's current state, which later edits would have moved.
 * Idempotency is never derived from a name or a phone number.
 */
@Entity({ tableName: 'patient_patients' })
@Index({ name: 'patient_patients_scope_status_created_idx', properties: ['tenantId', 'organizationId', 'status', 'createdAt'] })
@Index({ name: 'patient_patients_scope_owner_idx', properties: ['tenantId', 'organizationId', 'ownerTeamMemberId'] })
@Index({
  name: 'patient_patients_scope_number_uq',
  expression:
    `create unique index "patient_patients_scope_number_uq" on "patient_patients" ("tenant_id", "organization_id", "patient_number") where "deleted_at" is null`,
})
@Index({
  name: 'patient_patients_scope_request_uq',
  expression:
    `create unique index "patient_patients_scope_request_uq" on "patient_patients" ("tenant_id", "organization_id", "client_request_id")`,
})
// `archived_at` and `status` are one fact stored in two columns, so they must agree.
// Without this constraint a partial update could leave a record `archived` with no
// archival timestamp, and the detail page would render an archived card that claims it
// was never archived.
@Check({
  name: 'patient_patients_archived_at_matches_status_chk',
  expression: `("status" = 'archived') = ("archived_at" is not null)`,
})
export class Patient {
  [OptionalProps]?: 'status' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'archivedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Server-assigned, immutable, non-clinical handle (`P-<uuid>`). Never a national id. */
  @Property({ name: 'patient_number', type: 'text' })
  patientNumber!: string

  /** Encrypted. Reachable by exact search through the hashed token index only. */
  @Property({ name: 'first_name', type: 'text' })
  firstName!: string

  /** Encrypted. Reachable by exact search through the hashed token index only. */
  @Property({ name: 'last_name', type: 'text' })
  lastName!: string

  /**
   * Encrypted ISO-8601 date (`YYYY-MM-DD`) stored as text.
   *
   * Deliberately not a SQL `date`: the column holds ciphertext, and a `date` column
   * cannot. The API schema is what validates the calendar date and rejects a future one.
   */
  @Property({ name: 'birth_date', type: 'text', nullable: true })
  birthDate?: string | null

  /** Encrypted. At least one of `email` / `phone` is required by the API schema. */
  @Property({ type: 'text', nullable: true })
  email?: string | null

  /** Encrypted. Keeps its country prefix; never normalized into a bare local number. */
  @Property({ type: 'text', nullable: true })
  phone?: string | null

  /** Encrypted organisational note, never a substitute for a diagnosis. */
  @Property({ type: 'text', nullable: true })
  description?: string | null

  /** Scalar `staff:staff_team_member`. Optional, and never an authorization grant. */
  @Property({ name: 'owner_team_member_id', type: 'uuid', nullable: true })
  ownerTeamMemberId?: string | null

  @Property({ type: 'text', default: 'active' })
  status: PatientStatus = 'active'

  @Property({ name: 'archived_at', type: Date, nullable: true })
  archivedAt?: Date | null

  @Property({ name: 'client_request_id', type: 'uuid' })
  clientRequestId!: string

  /**
   * Encrypted, normalized original create request. Immutable, never returned by the
   * API, never logged. Excludes scope, actors and version tokens so a legitimate retry
   * from a different session still compares equal.
   */
  @Property({ name: 'create_request_payload', type: 'text' })
  createRequestPayload!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string

  @Property({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId!: string

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * A patient's own address — `patient_addresses`.
 *
 * The column set matches the shared CRM address editor's contract so the same
 * `AddressesSection` component and the same `AddressDataAdapter` shape can drive it.
 * What it does NOT do is reuse the CRM table: `customer_addresses` has a FK to
 * `CustomerEntity`, and a patient is not required to be a CRM person at all, so
 * pushing a patient id through `/api/customers/addresses` would violate that contract.
 *
 * Every text column and both coordinates are encrypted — an address is identifying
 * data. The coordinates are therefore `text`, not `numeric`, and the adapter decodes
 * them to numbers on read. There is no geocoding.
 */
@Entity({ tableName: 'patient_addresses' })
@Index({ name: 'patient_addresses_scope_patient_idx', properties: ['tenantId', 'organizationId', 'patientId'] })
@Index({
  name: 'patient_addresses_one_primary_uq',
  expression:
    `create unique index "patient_addresses_one_primary_uq" on "patient_addresses" ("tenant_id", "organization_id", "patient_id") where "is_primary" and "deleted_at" is null`,
})
export class PatientAddress {
  [OptionalProps]?: 'isPrimary' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** FK inside this module; the command always scopes the parent lookup too. */
  @Property({ name: 'patient_id', type: 'uuid' })
  patientId!: string

  /** Encrypted label, e.g. "Home". */
  @Property({ type: 'text', nullable: true })
  name?: string | null

  /** Address purpose from the shared editor's vocabulary. */
  @Property({ type: 'text', nullable: true })
  purpose?: string | null

  /** Encrypted. */
  @Property({ name: 'company_name', type: 'text', nullable: true })
  companyName?: string | null

  /** Encrypted. */
  @Property({ name: 'address_line1', type: 'text' })
  addressLine1!: string

  /** Encrypted. */
  @Property({ name: 'address_line2', type: 'text', nullable: true })
  addressLine2?: string | null

  /** Encrypted. */
  @Property({ name: 'building_number', type: 'text', nullable: true })
  buildingNumber?: string | null

  /** Encrypted. */
  @Property({ name: 'flat_number', type: 'text', nullable: true })
  flatNumber?: string | null

  /** Encrypted. Required for the first address. */
  @Property({ type: 'text', nullable: true })
  city?: string | null

  /** Encrypted. */
  @Property({ type: 'text', nullable: true })
  region?: string | null

  /** Encrypted. Optional — some countries have no postal code. */
  @Property({ name: 'postal_code', type: 'text', nullable: true })
  postalCode?: string | null

  /** ISO-3166 alpha-2, uppercase. Required for the first address. */
  @Property({ type: 'text', nullable: true })
  country?: string | null

  /** Encrypted text, decoded to a number by the adapter. No geocoding. */
  @Property({ type: 'text', nullable: true })
  latitude?: string | null

  /** Encrypted text, decoded to a number by the adapter. No geocoding. */
  @Property({ type: 'text', nullable: true })
  longitude?: string | null

  @Property({ name: 'is_primary', type: 'boolean', default: false })
  isPrimary: boolean = false

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string

  @Property({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId!: string

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * A link between a patient and a CRM person — `patient_contact_links`.
 *
 * `customer_entity_id` points at `customers:customer_entity` with `kind = 'person'`,
 * not at the `customer_people` profile. Both carry a uuid and the two are easy to
 * confuse; the CRM API operates on the entity, so that is the id stored here.
 *
 * The three roles are independent booleans rather than one enum because the spec needs
 * a guardian who is also the payer. `is_primary_contact` is a fourth, narrower flag —
 * at most one per patient, and meaningless without `is_contact`, which is what the
 * check constraint below pins.
 *
 * Nothing about the person is copied here. A phone number cached on the link would go
 * stale the moment CRM was edited, and would put identifying data in a second place.
 */
@Entity({ tableName: 'patient_contact_links' })
@Index({ name: 'patient_contact_links_scope_patient_idx', properties: ['tenantId', 'organizationId', 'patientId'] })
@Index({ name: 'patient_contact_links_scope_person_idx', properties: ['tenantId', 'organizationId', 'customerEntityId'] })
@Index({
  name: 'patient_contact_links_active_pair_uq',
  expression:
    `create unique index "patient_contact_links_active_pair_uq" on "patient_contact_links" ("tenant_id", "organization_id", "patient_id", "customer_entity_id") where "deleted_at" is null`,
})
@Index({
  name: 'patient_contact_links_one_primary_uq',
  expression:
    `create unique index "patient_contact_links_one_primary_uq" on "patient_contact_links" ("tenant_id", "organization_id", "patient_id") where "is_primary_contact" and "deleted_at" is null`,
})
@Check({
  name: 'patient_contact_links_at_least_one_role_chk',
  expression: `"is_guardian" or "is_contact" or "is_payer"`,
})
@Check({
  name: 'patient_contact_links_primary_requires_contact_chk',
  expression: `not "is_primary_contact" or "is_contact"`,
})
export class PatientContactLink {
  [OptionalProps]?:
    | 'isGuardian'
    | 'isContact'
    | 'isPayer'
    | 'isPrimaryContact'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'patient_id', type: 'uuid' })
  patientId!: string

  /** Scalar `customers:customer_entity` with `kind = 'person'`. Not the profile id. */
  @Property({ name: 'customer_entity_id', type: 'uuid' })
  customerEntityId!: string

  @Property({ name: 'is_guardian', type: 'boolean', default: false })
  isGuardian: boolean = false

  @Property({ name: 'is_contact', type: 'boolean', default: false })
  isContact: boolean = false

  /** Records who settles up. Carries no balance and no payment data. */
  @Property({ name: 'is_payer', type: 'boolean', default: false })
  isPayer: boolean = false

  @Property({ name: 'is_primary_contact', type: 'boolean', default: false })
  isPrimaryContact: boolean = false

  /** Encrypted free-text relationship label, e.g. "mother". */
  @Property({ name: 'relationship_label', type: 'text', nullable: true })
  relationshipLabel?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string

  @Property({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId!: string

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * A descriptive diagnosis — `patient_diagnoses`.
 *
 * The content is immutable once written. A correction inserts a NEW row pointing at
 * the old one through `supersedes_id` and flips the old row to `superseded`; it never
 * rewrites the description, because medical history must not lose what was originally
 * recorded. Voiding sets `voided`, requires a reason, and also keeps the text.
 *
 * `author_user_id` is taken from the authenticated session, never from the payload, and
 * it is a user id rather than a `team_member_id` — the author is whoever actually wrote
 * the entry.
 *
 * The partial unique on `supersedes_id` is what makes the chain single-threaded: two
 * concurrent corrections of the same entry cannot both land, so one gets a 409 instead
 * of the history forking into two competing successors.
 *
 * `code` / `code_system` are optional and validated as a pair. There is no dictionary
 * lookup in this version, and ICD is explicitly not mandatory.
 */
@Entity({ tableName: 'patient_diagnoses' })
@Index({ name: 'patient_diagnoses_scope_patient_date_idx', properties: ['tenantId', 'organizationId', 'patientId', 'diagnosedOn'] })
@Index({ name: 'patient_diagnoses_scope_status_idx', properties: ['tenantId', 'organizationId', 'status'] })
@Index({
  name: 'patient_diagnoses_scope_request_uq',
  expression:
    `create unique index "patient_diagnoses_scope_request_uq" on "patient_diagnoses" ("tenant_id", "organization_id", "client_request_id")`,
})
@Index({
  name: 'patient_diagnoses_single_successor_uq',
  expression:
    `create unique index "patient_diagnoses_single_successor_uq" on "patient_diagnoses" ("tenant_id", "organization_id", "supersedes_id") where "supersedes_id" is not null and "deleted_at" is null`,
})
// A row cannot supersede itself. The command also walks the chain to reject longer
// cycles; this constraint closes the one case a single statement could create.
@Check({
  name: 'patient_diagnoses_no_self_supersede_chk',
  expression: `"supersedes_id" is null or "supersedes_id" <> "id"`,
})
// `voided` is the only status that carries a reason and an actor, and it must carry
// all three. Anything else would render as a voided entry nobody can account for.
@Check({
  name: 'patient_diagnoses_void_fields_match_status_chk',
  expression:
    `("status" = 'voided') = ("voided_at" is not null) and ("voided_at" is null) = ("voided_by_user_id" is null) and ("voided_at" is null) = ("void_reason" is null)`,
})
export class PatientDiagnosis {
  [OptionalProps]?: 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'patient_id', type: 'uuid' })
  patientId!: string

  /** Encrypted. */
  @Property({ type: 'text' })
  title!: string

  /** Encrypted. Immutable after the write; a correction creates a new row. */
  @Property({ type: 'text' })
  description!: string

  /**
   * Calendar date of the diagnosis, not a timestamp.
   *
   * Not encrypted: it is the list's sort and range-filter column, and ciphertext
   * cannot be ordered in SQL. It is a date with no time component, so it discloses
   * materially less than the free text it accompanies.
   */
  @Property({ name: 'diagnosed_on', type: 'date' })
  diagnosedOn!: string

  /** Encrypted. Set together with `codeSystem` or both null. */
  @Property({ type: 'text', nullable: true })
  code?: string | null

  /** Encrypted. Set together with `code` or both null. */
  @Property({ name: 'code_system', type: 'text', nullable: true })
  codeSystem?: string | null

  /** Encrypted. Optional even when a code is present. */
  @Property({ name: 'code_version', type: 'text', nullable: true })
  codeVersion?: string | null

  /** Auth user id from the session. Never accepted from the payload. */
  @Property({ name: 'author_user_id', type: 'uuid' })
  authorUserId!: string

  /** The entry this one corrects. At most one successor per entry. */
  @Property({ name: 'supersedes_id', type: 'uuid', nullable: true })
  supersedesId?: string | null

  @Property({ type: 'text', default: 'active' })
  status: PatientDiagnosisStatus = 'active'

  /** Encrypted. Required when voided. */
  @Property({ name: 'void_reason', type: 'text', nullable: true })
  voidReason?: string | null

  @Property({ name: 'voided_at', type: Date, nullable: true })
  voidedAt?: Date | null

  @Property({ name: 'voided_by_user_id', type: 'uuid', nullable: true })
  voidedByUserId?: string | null

  @Property({ name: 'client_request_id', type: 'uuid' })
  clientRequestId!: string

  /** Encrypted, normalized original create request. Never returned, never logged. */
  @Property({ name: 'create_request_payload', type: 'text' })
  createRequestPayload!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string

  @Property({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId!: string

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * A link from a patient to a document owned by the `documents` module —
 * `patient_document_links`.
 *
 * This table exists because `documents`' own `DocumentEntityLink` has a closed enum of
 * eight entity types with no `patient` member, and extending an enum inside
 * `node_modules` is not permitted.
 *
 * `state` is what makes "create a new document from the patient card" safe without a
 * distributed transaction. The first transaction writes `pending_create` together with
 * the server-generated `document_id` / `content_id` and the encrypted working title;
 * then the documents module's own command creates the document with those exact ids;
 * then a second transaction flips the row to `linked`. A retry re-authorizes and
 * resumes the SAME intent, so an interrupted create can never leave two documents.
 * `creation_title` is dropped on activation — the document owns its title from then on.
 *
 * Pinning a document does NOT grant access to it. The document keeps its own
 * owner/share policy, and reading through the patient card requires both this module's
 * clinical feature and the native document ACL.
 */
@Entity({ tableName: 'patient_document_links' })
@Index({ name: 'patient_document_links_scope_patient_idx', properties: ['tenantId', 'organizationId', 'patientId'] })
@Index({ name: 'patient_document_links_scope_state_idx', properties: ['tenantId', 'organizationId', 'state'] })
@Index({
  name: 'patient_document_links_active_pair_uq',
  expression:
    `create unique index "patient_document_links_active_pair_uq" on "patient_document_links" ("tenant_id", "organization_id", "patient_id", "document_id") where "deleted_at" is null and "state" <> 'abandoned'`,
})
@Index({
  name: 'patient_document_links_scope_request_uq',
  expression:
    `create unique index "patient_document_links_scope_request_uq" on "patient_document_links" ("tenant_id", "organization_id", "client_request_id")`,
})
// The working title belongs to the creation intent and nothing else. Keeping it after
// activation would leave a second, stale copy of a title the document already owns.
@Check({
  name: 'patient_document_links_creation_title_only_pending_chk',
  expression: `"creation_title" is null or "state" = 'pending_create'`,
})
export class PatientDocumentLink {
  [OptionalProps]?: 'state' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'patient_id', type: 'uuid' })
  patientId!: string

  /** Scalar `documents:document`. Generated before the document exists on a create intent. */
  @Property({ name: 'document_id', type: 'uuid' })
  documentId!: string

  @Property({ type: 'text', default: 'linked' })
  state: PatientDocumentLinkState = 'linked'

  /** Server-generated content id handed to the documents command on a create intent. */
  @Property({ name: 'content_id', type: 'uuid', nullable: true })
  contentId?: string | null

  /** Encrypted working title, present only while `state = 'pending_create'`. */
  @Property({ name: 'creation_title', type: 'text', nullable: true })
  creationTitle?: string | null

  @Property({ name: 'client_request_id', type: 'uuid' })
  clientRequestId!: string

  /** Encrypted, normalized original create request. Never returned, never logged. */
  @Property({ name: 'create_request_payload', type: 'text' })
  createRequestPayload!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string

  @Property({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId!: string

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * A link from a patient (or one of their diagnoses) to a stored file —
 * `patient_attachment_links`.
 *
 * A file belongs either to the patient in general (`diagnosis_id is null`) or to one
 * diagnosis entry, and the card shows both with their source marked. The two partial
 * unique indexes mirror that split: one keyed on the patient for general files, one
 * keyed on the diagnosis for entry files. A single unique over all three columns would
 * treat `null` as distinct and let the same file be pinned to a patient twice.
 *
 * `attachment_id` is a scalar owned by the `attachments` module. This module never
 * reads that module's ORM — only its public service.
 *
 * `original_file_name` is encrypted and exists purely as a UI label. The name used in
 * storage is a neutral identifier: a file called `diagnosis-autism-kowalski.pdf` in a
 * storage listing would disclose the content of the record it belongs to.
 *
 * Whether these rows can be written at all depends on the host's owner-authorization
 * contract (SEC-ATT). See `../lib/clinicalFileGate.ts`.
 */
@Entity({ tableName: 'patient_attachment_links' })
@Index({ name: 'patient_attachment_links_scope_patient_idx', properties: ['tenantId', 'organizationId', 'patientId'] })
@Index({ name: 'patient_attachment_links_scope_diagnosis_idx', properties: ['tenantId', 'organizationId', 'diagnosisId'] })
// Authorizing a reference works backwards from the attachment id, so that direction
// needs its own index — this is the lookup the download gate performs on every read.
@Index({ name: 'patient_attachment_links_scope_attachment_idx', properties: ['tenantId', 'organizationId', 'attachmentId'] })
@Index({
  name: 'patient_attachment_links_active_patient_pair_uq',
  expression:
    `create unique index "patient_attachment_links_active_patient_pair_uq" on "patient_attachment_links" ("tenant_id", "organization_id", "patient_id", "attachment_id") where "diagnosis_id" is null and "state" = 'active' and "deleted_at" is null`,
})
@Index({
  name: 'patient_attachment_links_active_diagnosis_pair_uq',
  expression:
    `create unique index "patient_attachment_links_active_diagnosis_pair_uq" on "patient_attachment_links" ("tenant_id", "organization_id", "diagnosis_id", "attachment_id") where "diagnosis_id" is not null and "state" = 'active' and "deleted_at" is null`,
})
@Index({
  name: 'patient_attachment_links_scope_request_uq',
  expression:
    `create unique index "patient_attachment_links_scope_request_uq" on "patient_attachment_links" ("tenant_id", "organization_id", "client_request_id")`,
})
export class PatientAttachmentLink {
  [OptionalProps]?: 'state' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'patient_id', type: 'uuid' })
  patientId!: string

  /** Scalar `attachments:attachment`. Reached only through the public service. */
  @Property({ name: 'attachment_id', type: 'uuid' })
  attachmentId!: string

  /** When set, must be a diagnosis of the same patient. */
  @Property({ name: 'diagnosis_id', type: 'uuid', nullable: true })
  diagnosisId?: string | null

  @Property({ type: 'text', default: 'active' })
  state: PatientAttachmentLinkState = 'active'

  /** Encrypted UI label. The storage identifier is neutral and unrelated to this. */
  @Property({ name: 'original_file_name', type: 'text', nullable: true })
  originalFileName?: string | null

  @Property({ name: 'client_request_id', type: 'uuid' })
  clientRequestId!: string

  /**
   * Encrypted, normalized original create request. For a file this records the
   * operation metadata and the upload identifier — never the bytes.
   */
  @Property({ name: 'create_request_payload', type: 'text' })
  createRequestPayload!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string

  @Property({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId!: string

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * A scheduled or historical visit belonging to one patient — `patient:patient_visit`.
 *
 * Installed-module references stay scalar ids with server-owned snapshots. The only ORM
 * relation is the same-module patient FK, represented as its primary key so commands and
 * response DTOs keep using `patientId` rather than leaking an ORM object.
 */
@Entity({ tableName: 'patient_visits' })
@Index({ name: 'patient_visits_scope_patient_start_idx', properties: ['tenantId', 'organizationId', 'patientId', 'startsAt'] })
@Index({ name: 'patient_visits_scope_staff_start_idx', properties: ['tenantId', 'organizationId', 'teamMemberId', 'startsAt'] })
@Index({ name: 'patient_visits_scope_resource_start_idx', properties: ['tenantId', 'organizationId', 'resourceId', 'startsAt'] })
@Index({ name: 'patient_visits_scope_start_id_idx', properties: ['tenantId', 'organizationId', 'startsAt', 'id'] })
@Index({ name: 'patient_visits_scope_status_start_idx', properties: ['tenantId', 'organizationId', 'status', 'startsAt'] })
@Index({ name: 'patient_visits_scope_settled_start_idx', properties: ['tenantId', 'organizationId', 'isSettled', 'startsAt'] })
@Index({
  name: 'patient_visits_scope_request_uq',
  expression:
    `create unique index "patient_visits_scope_request_uq" on "patient_visits" ("tenant_id", "organization_id", "client_request_id")`,
})
@Check({
  name: 'patient_visits_end_after_start_chk',
  expression: `"ends_at" is null or "ends_at" > "starts_at"`,
})
@Check({
  name: 'patient_visits_confirmation_pair_chk',
  expression: `("confirmed_at" is null) = ("confirmed_by_user_id" is null)`,
})
@Check({
  name: 'patient_visits_resource_snapshot_pair_chk',
  expression: `("resource_id" is null) = ("resource_name_snapshot" is null)`,
})
@Check({
  name: 'patient_visits_settlement_fields_chk',
  expression:
    `("is_settled" and "settled_at" is not null and "settled_by_user_id" is not null) or (not "is_settled" and "settled_at" is null and "settled_by_user_id" is null)`,
})
export class PatientVisit {
  [OptionalProps]?:
    | 'status'
    | 'isSettled'
    | 'confirmedAt'
    | 'confirmedByUserId'
    | 'settledAt'
    | 'settledByUserId'
    | 'statusReason'
    | 'settlementReason'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => Patient, { fieldName: 'patient_id', mapToPk: true, deleteRule: 'restrict', updateRule: 'cascade' })
  patientId!: string

  /** Scalar `staff:staff_team_member`; never an auth user id. */
  @Property({ name: 'team_member_id', type: 'uuid' })
  teamMemberId!: string

  /** Encrypted historical display name, refreshed only when the selected member changes. */
  @Property({ name: 'team_member_name_snapshot', type: 'text' })
  teamMemberNameSnapshot!: string

  /** Optional scalar `resources:resources_resource`. No reservation is implied. */
  @Property({ name: 'resource_id', type: 'uuid', nullable: true })
  resourceId?: string | null

  @Property({ name: 'resource_name_snapshot', type: 'text', nullable: true })
  resourceNameSnapshot?: string | null

  @Property({ name: 'starts_at', type: Date })
  startsAt!: Date

  @Property({ name: 'ends_at', type: Date, nullable: true })
  endsAt?: Date | null

  @Property({ name: 'time_zone', type: 'text' })
  timeZone!: string

  /** Encrypted organisational note. Clinical content belongs in diagnoses. */
  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ type: 'text', default: 'planned' })
  status: PatientVisitStatus = 'planned'

  @Property({ name: 'confirmed_at', type: Date, nullable: true })
  confirmedAt?: Date | null

  @Property({ name: 'confirmed_by_user_id', type: 'uuid', nullable: true })
  confirmedByUserId?: string | null

  @Property({ name: 'status_changed_at', type: Date })
  statusChangedAt!: Date

  @Property({ name: 'status_changed_by_user_id', type: 'uuid' })
  statusChangedByUserId!: string

  /** Encrypted reason for cancel/no-show/reopen. */
  @Property({ name: 'status_reason', type: 'text', nullable: true })
  statusReason?: string | null

  @Property({ name: 'is_settled', type: 'boolean', default: false })
  isSettled: boolean = false

  @Property({ name: 'settled_at', type: Date, nullable: true })
  settledAt?: Date | null

  @Property({ name: 'settled_by_user_id', type: 'uuid', nullable: true })
  settledByUserId?: string | null

  /** Encrypted reason for the most recent settlement change. */
  @Property({ name: 'settlement_reason', type: 'text', nullable: true })
  settlementReason?: string | null

  @Property({ name: 'client_request_id', type: 'uuid' })
  clientRequestId!: string

  /** Encrypted normalized original create payload, never returned or logged. */
  @Property({ name: 'create_request_payload', type: 'text' })
  createRequestPayload!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string

  @Property({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId!: string

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/** One ordered catalog service snapshot inside a visit aggregate. */
@Entity({ tableName: 'patient_visit_services' })
@Index({ name: 'patient_visit_services_scope_visit_position_idx', properties: ['tenantId', 'organizationId', 'visitId', 'position'] })
@Index({
  name: 'patient_visit_services_active_product_uq',
  expression:
    `create unique index "patient_visit_services_active_product_uq" on "patient_visit_services" ("tenant_id", "organization_id", "visit_id", "product_id") where "deleted_at" is null`,
})
@Check({ name: 'patient_visit_services_position_nonnegative_chk', expression: `"position" >= 0` })
export class PatientVisitService {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => PatientVisit, { fieldName: 'visit_id', mapToPk: true, deleteRule: 'restrict', updateRule: 'cascade' })
  visitId!: string

  /** Scalar `catalog:catalog_product`, intentionally not a variant id. */
  @Property({ name: 'product_id', type: 'uuid' })
  productId!: string

  @Property({ name: 'product_title_snapshot', type: 'text' })
  productTitleSnapshot!: string

  @Property({ name: 'product_sku_snapshot', type: 'text', nullable: true })
  productSkuSnapshot?: string | null

  @Property({ type: 'integer' })
  position!: number

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string

  @Property({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId!: string

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
