import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

/**
 * At-rest encryption for this module's entities.
 *
 * Tenant data encryption is on unless `TENANT_DATA_ENCRYPTION` is explicitly turned
 * off, but these rows are only *materialized* as `EncryptionMap` records at tenant
 * creation or by `yarn mercato entities seed-encryption --tenant <id>`. Declaring a
 * field here therefore protects new tenants automatically and existing tenants once
 * that CLI has run — which the spec's rollout step 2 requires before any real data.
 *
 * Encrypting a field is a decision about every read path that touches it. A column
 * holding ciphertext cannot be ordered in SQL, cannot be matched with a plaintext
 * `ilike` pattern, and must not be exported to CSV. The consequences this module
 * accepts in exchange:
 *
 * - The patient list sorts by `patient_number`, `created_at` and `status` — never by
 *   name. Name search is exact-match through the hashed token index, never `ilike`.
 * - The list DOES project the name and contact columns, because the grid renders them, and
 *   accepts the per-row decrypt that costs. What it does not project is `description`:
 *   nothing in a list renders it, so decrypting it per row would be pure cost over the
 *   module's longest free-text field.
 * - No CSV export at all. The spec lists a clinical CSV as a non-goal, and the columns a
 *   grid renders are exactly the ones an export would copy out to a file nobody
 *   re-encrypts.
 *
 * What is deliberately NOT encrypted, and why:
 *
 * - `patient_number` — the unique scope key, the default sort column and the exact
 *   search handle. It is server-generated `P-<uuid>` and carries no personal data, so
 *   encrypting it would cost all three capabilities and protect nothing.
 * - `diagnosed_on` — the diagnosis list's sort and range-filter column. A date with no
 *   time component, disclosing far less than the description it accompanies.
 * - `status`, `state`, the role booleans and `is_primary` — low-cardinality filter
 *   columns. Ciphertext over a handful of distinct values is trivially distinguishable
 *   by frequency, so encrypting them would add cost without adding secrecy.
 * - Scalar reference ids and scope columns — they are the join and authorization keys.
 *   The spec is explicit that times, relations and indexes stay metadata protected by
 *   ACL and infrastructure encryption; it does not promise an encrypted relation graph.
 *
 * `country` is listed even though it is a two-letter code: combined with a city and a
 * street it is part of one identifying address, and leaving one field of an address in
 * plaintext is not a meaningful saving.
 */
export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'patient:patient',
    fields: [
      { field: 'first_name' },
      { field: 'last_name' },
      // ISO date stored as text precisely so it can hold ciphertext.
      { field: 'birth_date' },
      { field: 'email' },
      { field: 'phone' },
      { field: 'description' },
      // The normalized original create request. Encrypted, never returned, never logged.
      { field: 'create_request_payload' },
    ],
  },
  {
    entityId: 'patient:patient_address',
    fields: [
      { field: 'name' },
      { field: 'company_name' },
      { field: 'address_line1' },
      { field: 'address_line2' },
      { field: 'building_number' },
      { field: 'flat_number' },
      { field: 'city' },
      { field: 'region' },
      { field: 'postal_code' },
      { field: 'country' },
      // Coordinates are stored as text for this reason; the adapter decodes them.
      { field: 'latitude' },
      { field: 'longitude' },
    ],
  },
  {
    entityId: 'patient:patient_contact_link',
    fields: [{ field: 'relationship_label' }],
  },
  {
    entityId: 'patient:patient_diagnosis',
    fields: [
      { field: 'title' },
      { field: 'description' },
      { field: 'code' },
      { field: 'code_system' },
      { field: 'code_version' },
      { field: 'void_reason' },
      { field: 'create_request_payload' },
    ],
  },
  {
    entityId: 'patient:patient_document_link',
    fields: [
      // Only ever populated while the creation intent is pending.
      { field: 'creation_title' },
      { field: 'create_request_payload' },
    ],
  },
  {
    entityId: 'patient:patient_attachment_link',
    fields: [
      { field: 'original_file_name' },
      { field: 'create_request_payload' },
    ],
  },
  {
    entityId: 'patient:patient_visit',
    fields: [
      { field: 'team_member_name_snapshot' },
      { field: 'resource_name_snapshot' },
      { field: 'description' },
      { field: 'status_reason' },
      { field: 'settlement_reason' },
      { field: 'create_request_payload' },
    ],
  },
  {
    entityId: 'patient:patient_visit_service',
    fields: [
      { field: 'product_title_snapshot' },
      { field: 'product_sku_snapshot' },
    ],
  },
]

export default defaultEncryptionMaps
