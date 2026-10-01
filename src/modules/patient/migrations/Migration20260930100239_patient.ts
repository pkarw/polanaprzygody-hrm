import { Migration } from '@mikro-orm/migrations';

export class Migration20260930100239_patient extends Migration {

  override name = 'Migration20260930100239';

  override up(): void | Promise<void> {
    this.addSql(`create table "patient_visits" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "patient_id" uuid not null, "team_member_id" uuid not null, "team_member_name_snapshot" text not null, "resource_id" uuid null, "resource_name_snapshot" text null, "starts_at" timestamptz not null, "ends_at" timestamptz null, "time_zone" text not null, "description" text null, "status" text not null default 'planned', "confirmed_at" timestamptz null, "confirmed_by_user_id" uuid null, "status_changed_at" timestamptz not null, "status_changed_by_user_id" uuid not null, "status_reason" text null, "is_settled" boolean not null default false, "settled_at" timestamptz null, "settled_by_user_id" uuid null, "settlement_reason" text null, "client_request_id" uuid not null, "create_request_payload" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "created_by_user_id" uuid not null, "updated_by_user_id" uuid not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "patient_visits_scope_request_uq" on "patient_visits" ("tenant_id", "organization_id", "client_request_id");`);
    this.addSql(`create index "patient_visits_scope_settled_start_idx" on "patient_visits" ("tenant_id", "organization_id", "is_settled", "starts_at");`);
    this.addSql(`create index "patient_visits_scope_status_start_idx" on "patient_visits" ("tenant_id", "organization_id", "status", "starts_at");`);
    this.addSql(`create index "patient_visits_scope_start_id_idx" on "patient_visits" ("tenant_id", "organization_id", "starts_at", "id");`);
    this.addSql(`create index "patient_visits_scope_resource_start_idx" on "patient_visits" ("tenant_id", "organization_id", "resource_id", "starts_at");`);
    this.addSql(`create index "patient_visits_scope_staff_start_idx" on "patient_visits" ("tenant_id", "organization_id", "team_member_id", "starts_at");`);
    this.addSql(`create index "patient_visits_scope_patient_start_idx" on "patient_visits" ("tenant_id", "organization_id", "patient_id", "starts_at");`);

    this.addSql(`create table "patient_visit_services" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "visit_id" uuid not null, "product_id" uuid not null, "product_title_snapshot" text not null, "product_sku_snapshot" text null, "position" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "created_by_user_id" uuid not null, "updated_by_user_id" uuid not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "patient_visit_services_active_product_uq" on "patient_visit_services" ("tenant_id", "organization_id", "visit_id", "product_id") where "deleted_at" is null;`);
    this.addSql(`create index "patient_visit_services_scope_visit_position_idx" on "patient_visit_services" ("tenant_id", "organization_id", "visit_id", "position");`);

    this.addSql(`alter table "patient_visits" add constraint "patient_visits_patient_id_foreign" foreign key ("patient_id") references "patient_patients" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "patient_visits" add constraint "patient_visits_settlement_fields_chk" check (("is_settled" and "settled_at" is not null and "settled_by_user_id" is not null) or (not "is_settled" and "settled_at" is null and "settled_by_user_id" is null));`);
    this.addSql(`alter table "patient_visits" add constraint "patient_visits_resource_snapshot_pair_chk" check (("resource_id" is null) = ("resource_name_snapshot" is null));`);
    this.addSql(`alter table "patient_visits" add constraint "patient_visits_confirmation_pair_chk" check (("confirmed_at" is null) = ("confirmed_by_user_id" is null));`);
    this.addSql(`alter table "patient_visits" add constraint "patient_visits_end_after_start_chk" check ("ends_at" is null or "ends_at" > "starts_at");`);

    this.addSql(`alter table "patient_visit_services" add constraint "patient_visit_services_visit_id_foreign" foreign key ("visit_id") references "patient_visits" ("id") on update cascade on delete restrict;`);
    this.addSql(`alter table "patient_visit_services" add constraint "patient_visit_services_position_nonnegative_chk" check ("position" >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "patient_visit_services" drop constraint if exists "patient_visit_services_visit_id_foreign";`);
    this.addSql(`alter table "patient_visits" drop constraint if exists "patient_visits_patient_id_foreign";`);
    this.addSql(`drop table if exists "patient_visit_services" cascade;`);
    this.addSql(`drop table if exists "patient_visits" cascade;`);
  }

}
