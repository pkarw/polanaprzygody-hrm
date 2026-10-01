import { Migration } from '@mikro-orm/migrations';

export class Migration20261001213720_public_booking extends Migration {

  override name = 'Migration20261001213720';

  override up(): void | Promise<void> {
    this.addSql(`create table "public_booking_customer_identities" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "customer_entity_id" uuid not null, "email_hash" text null, "phone_hash" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "public_booking_customer_identities_scope_phone_idx" on "public_booking_customer_identities" ("tenant_id", "organization_id", "phone_hash");`);
    this.addSql(`create index "public_booking_customer_identities_scope_email_idx" on "public_booking_customer_identities" ("tenant_id", "organization_id", "email_hash");`);
    this.addSql(`alter table "public_booking_customer_identities" add constraint "public_booking_customer_identities_scope_customer_uq" unique ("tenant_id", "organization_id", "customer_entity_id");`);
  }

}
