import { Migration } from '@mikro-orm/migrations';

export class Migration20261001193128_patient extends Migration {

  override name = 'Migration20261001193128';

  override up(): void | Promise<void> {
    this.addSql(`create table "patient_visit_payment_email_deliveries" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "visit_id" uuid not null, "payment_link_id" uuid not null, "operation_key" text not null, "status" text not null default 'pending', "claimed_at" timestamptz null, "sent_at" timestamptz null, "failed_at" timestamptz null, "failure_code" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create unique index "patient_visit_payment_email_deliveries_scope_operation_uq" on "patient_visit_payment_email_deliveries" ("tenant_id", "organization_id", "operation_key");`);
    this.addSql(`create index "patient_visit_payment_email_deliveries_scope_visit_created_idx" on "patient_visit_payment_email_deliveries" ("tenant_id", "organization_id", "visit_id", "created_at");`);

    this.addSql(`alter table "patient_visit_payment_email_deliveries" add constraint "patient_visit_payment_email_deliveries_status_chk" check ("status" in ('pending', 'sending', 'sent', 'failed', 'ambiguous'));`);
  }

}
