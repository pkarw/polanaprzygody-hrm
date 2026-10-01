import { Migration } from '@mikro-orm/migrations';

export class Migration20260930190908_patient extends Migration {

  override name = 'Migration20260930190908';

  override up(): void | Promise<void> {
    // The rollback intentionally retains these audit columns and their data. Keep
    // the forward path repeatable so a later redeploy can re-apply VCAL-1 safely.
    this.addSql(`alter table "patient_visits" add column if not exists "conflict_override_reason" text null;`);
    this.addSql(`alter table "patient_visits" add column if not exists "conflict_override_at" timestamptz null;`);
    this.addSql(`alter table "patient_visits" add column if not exists "conflict_override_by_user_id" uuid null;`);
    this.addSql(`alter table "patient_visits" add column if not exists "conflict_override_codes" jsonb null;`);
    this.addSql(`create index if not exists "patient_visits_resource_busy_idx" on "patient_visits" ("tenant_id", "organization_id", "resource_id", "starts_at", "ends_at") where "deleted_at" is null and "status" <> 'cancelled' and "resource_id" is not null;`);
    this.addSql(`create index if not exists "patient_visits_member_busy_idx" on "patient_visits" ("tenant_id", "organization_id", "team_member_id", "starts_at", "ends_at") where "deleted_at" is null and "status" <> 'cancelled';`);
    this.addSql(`alter table "patient_visits" add constraint "patient_visits_conflict_override_fields_chk" check (("conflict_override_reason" is null and "conflict_override_at" is null and "conflict_override_by_user_id" is null and "conflict_override_codes" is null) or ("conflict_override_reason" is not null and "conflict_override_at" is not null and "conflict_override_by_user_id" is not null and jsonb_typeof("conflict_override_codes") = 'array' and jsonb_array_length("conflict_override_codes") > 0));`);
    this.addSql(`update "encryption_maps"
      set "fields_json" = coalesce("fields_json", '[]'::jsonb) || '[{"field":"conflict_override_reason"}]'::jsonb,
          "updated_at" = now()
      where "entity_id" = 'patient:patient_visit'
        and "is_active" = true
        and "deleted_at" is null
        and not exists (
          select 1 from jsonb_array_elements(coalesce("fields_json", '[]'::jsonb)) item
          where item->>'field' = 'conflict_override_reason'
        );`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index if exists "patient_visits_resource_busy_idx";`);
    this.addSql(`drop index if exists "patient_visits_member_busy_idx";`);
    this.addSql(`alter table "patient_visits" drop constraint if exists "patient_visits_conflict_override_fields_chk";`);
    // Conflict-override fields are an immutable audit trail. Retain the columns,
    // ciphertext, and encryption-map entry when application behavior rolls back.
  }

}
