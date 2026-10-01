import { Migration } from '@mikro-orm/migrations';

export class Migration20261001161632_public_booking extends Migration {

  override name = 'Migration20261001161632';

  override up(): void | Promise<void> {
    this.addSql(`create table "public_booking_intakes" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "visit_id" uuid not null, "customer_entity_id" uuid not null, "patient_id" uuid not null, "product_id" uuid not null, "requester_name_snapshot" text not null, "requester_email_snapshot" text null, "requester_phone_snapshot" text not null, "consent_proof" text not null, "client_idempotency_key" text not null, "request_payload_hash" text not null, "submitted_at" timestamptz not null, "confirmation_email_sent_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "public_booking_intakes_scope_idempotency_uq" on "public_booking_intakes" ("tenant_id", "organization_id", "client_idempotency_key");`);
    this.addSql(`create unique index "public_booking_intakes_scope_visit_uq" on "public_booking_intakes" ("tenant_id", "organization_id", "visit_id") where "deleted_at" is null;`);
    this.addSql(`create index "public_booking_intakes_scope_submitted_idx" on "public_booking_intakes" ("tenant_id", "organization_id", "submitted_at");`);
    this.addSql(`alter table "public_booking_intakes" add constraint "public_booking_intakes_request_hash_chk" check ("request_payload_hash" ~ '^[0-9a-f]{64}\$');`);

    this.addSql(`create table "public_booking_service_credentials" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "service_user_id" uuid not null, "api_key_id" uuid not null, "api_key_secret" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "public_booking_service_credentials_scope_uq" on "public_booking_service_credentials" ("tenant_id", "organization_id") where "deleted_at" is null;`);
  }

}
