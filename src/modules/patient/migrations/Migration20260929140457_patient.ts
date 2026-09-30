import { Migration } from '@mikro-orm/migrations';

export class Migration20260929140457_patient extends Migration {

  override name = 'Migration20260929140457';

  override up(): void | Promise<void> {
    this.addSql(`create table "patient_patients" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "patient_number" text not null, "first_name" text not null, "last_name" text not null, "birth_date" text null, "email" text null, "phone" text null, "description" text null, "owner_team_member_id" uuid null, "status" text not null default 'active', "archived_at" timestamptz null, "client_request_id" uuid not null, "create_request_payload" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "created_by_user_id" uuid not null, "updated_by_user_id" uuid not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "patient_patients_scope_request_uq" on "patient_patients" ("tenant_id", "organization_id", "client_request_id");`);
    this.addSql(`create unique index "patient_patients_scope_number_uq" on "patient_patients" ("tenant_id", "organization_id", "patient_number") where "deleted_at" is null;`);
    this.addSql(`create index "patient_patients_scope_owner_idx" on "patient_patients" ("tenant_id", "organization_id", "owner_team_member_id");`);
    this.addSql(`create index "patient_patients_scope_status_created_idx" on "patient_patients" ("tenant_id", "organization_id", "status", "created_at");`);
    this.addSql(`alter table "patient_patients" add constraint "patient_patients_archived_at_matches_status_chk" check (("status" = 'archived') = ("archived_at" is not null));`);

    this.addSql(`create table "patient_addresses" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "patient_id" uuid not null, "name" text null, "purpose" text null, "company_name" text null, "address_line1" text not null, "address_line2" text null, "building_number" text null, "flat_number" text null, "city" text null, "region" text null, "postal_code" text null, "country" text null, "latitude" text null, "longitude" text null, "is_primary" boolean not null default false, "created_at" timestamptz not null, "updated_at" timestamptz not null, "created_by_user_id" uuid not null, "updated_by_user_id" uuid not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "patient_addresses_one_primary_uq" on "patient_addresses" ("tenant_id", "organization_id", "patient_id") where "is_primary" and "deleted_at" is null;`);
    this.addSql(`create index "patient_addresses_scope_patient_idx" on "patient_addresses" ("tenant_id", "organization_id", "patient_id");`);

    this.addSql(`create table "patient_attachment_links" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "patient_id" uuid not null, "attachment_id" uuid not null, "diagnosis_id" uuid null, "state" text not null default 'active', "original_file_name" text null, "client_request_id" uuid not null, "create_request_payload" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "created_by_user_id" uuid not null, "updated_by_user_id" uuid not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "patient_attachment_links_scope_request_uq" on "patient_attachment_links" ("tenant_id", "organization_id", "client_request_id");`);
    this.addSql(`create unique index "patient_attachment_links_active_diagnosis_pair_uq" on "patient_attachment_links" ("tenant_id", "organization_id", "diagnosis_id", "attachment_id") where "diagnosis_id" is not null and "state" = 'active' and "deleted_at" is null;`);
    this.addSql(`create unique index "patient_attachment_links_active_patient_pair_uq" on "patient_attachment_links" ("tenant_id", "organization_id", "patient_id", "attachment_id") where "diagnosis_id" is null and "state" = 'active' and "deleted_at" is null;`);
    this.addSql(`create index "patient_attachment_links_scope_attachment_idx" on "patient_attachment_links" ("tenant_id", "organization_id", "attachment_id");`);
    this.addSql(`create index "patient_attachment_links_scope_diagnosis_idx" on "patient_attachment_links" ("tenant_id", "organization_id", "diagnosis_id");`);
    this.addSql(`create index "patient_attachment_links_scope_patient_idx" on "patient_attachment_links" ("tenant_id", "organization_id", "patient_id");`);

    this.addSql(`create table "patient_contact_links" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "patient_id" uuid not null, "customer_entity_id" uuid not null, "is_guardian" boolean not null default false, "is_contact" boolean not null default false, "is_payer" boolean not null default false, "is_primary_contact" boolean not null default false, "relationship_label" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "created_by_user_id" uuid not null, "updated_by_user_id" uuid not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "patient_contact_links_one_primary_uq" on "patient_contact_links" ("tenant_id", "organization_id", "patient_id") where "is_primary_contact" and "deleted_at" is null;`);
    this.addSql(`create unique index "patient_contact_links_active_pair_uq" on "patient_contact_links" ("tenant_id", "organization_id", "patient_id", "customer_entity_id") where "deleted_at" is null;`);
    this.addSql(`create index "patient_contact_links_scope_person_idx" on "patient_contact_links" ("tenant_id", "organization_id", "customer_entity_id");`);
    this.addSql(`create index "patient_contact_links_scope_patient_idx" on "patient_contact_links" ("tenant_id", "organization_id", "patient_id");`);
    this.addSql(`alter table "patient_contact_links" add constraint "patient_contact_links_primary_requires_contact_chk" check (not "is_primary_contact" or "is_contact");`);
    this.addSql(`alter table "patient_contact_links" add constraint "patient_contact_links_at_least_one_role_chk" check ("is_guardian" or "is_contact" or "is_payer");`);

    this.addSql(`create table "patient_diagnoses" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "patient_id" uuid not null, "title" text not null, "description" text not null, "diagnosed_on" date not null, "code" text null, "code_system" text null, "code_version" text null, "author_user_id" uuid not null, "supersedes_id" uuid null, "status" text not null default 'active', "void_reason" text null, "voided_at" timestamptz null, "voided_by_user_id" uuid null, "client_request_id" uuid not null, "create_request_payload" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "created_by_user_id" uuid not null, "updated_by_user_id" uuid not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "patient_diagnoses_single_successor_uq" on "patient_diagnoses" ("tenant_id", "organization_id", "supersedes_id") where "supersedes_id" is not null and "deleted_at" is null;`);
    this.addSql(`create unique index "patient_diagnoses_scope_request_uq" on "patient_diagnoses" ("tenant_id", "organization_id", "client_request_id");`);
    this.addSql(`create index "patient_diagnoses_scope_status_idx" on "patient_diagnoses" ("tenant_id", "organization_id", "status");`);
    this.addSql(`create index "patient_diagnoses_scope_patient_date_idx" on "patient_diagnoses" ("tenant_id", "organization_id", "patient_id", "diagnosed_on");`);
    this.addSql(`alter table "patient_diagnoses" add constraint "patient_diagnoses_void_fields_match_status_chk" check (("status" = 'voided') = ("voided_at" is not null) and ("voided_at" is null) = ("voided_by_user_id" is null) and ("voided_at" is null) = ("void_reason" is null));`);
    this.addSql(`alter table "patient_diagnoses" add constraint "patient_diagnoses_no_self_supersede_chk" check ("supersedes_id" is null or "supersedes_id" <> "id");`);

    this.addSql(`create table "patient_document_links" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "patient_id" uuid not null, "document_id" uuid not null, "state" text not null default 'linked', "content_id" uuid null, "creation_title" text null, "client_request_id" uuid not null, "create_request_payload" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "created_by_user_id" uuid not null, "updated_by_user_id" uuid not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "patient_document_links_scope_request_uq" on "patient_document_links" ("tenant_id", "organization_id", "client_request_id");`);
    this.addSql(`create unique index "patient_document_links_active_pair_uq" on "patient_document_links" ("tenant_id", "organization_id", "patient_id", "document_id") where "deleted_at" is null and "state" <> 'abandoned';`);
    this.addSql(`create index "patient_document_links_scope_state_idx" on "patient_document_links" ("tenant_id", "organization_id", "state");`);
    this.addSql(`create index "patient_document_links_scope_patient_idx" on "patient_document_links" ("tenant_id", "organization_id", "patient_id");`);
    this.addSql(`alter table "patient_document_links" add constraint "patient_document_links_creation_title_only_pending_chk" check ("creation_title" is null or "state" = 'pending_create');`);
  }

}
