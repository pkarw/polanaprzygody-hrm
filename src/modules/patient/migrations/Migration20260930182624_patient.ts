import { Migration } from '@mikro-orm/migrations';
import { declareQueryIndexReindex } from '@open-mercato/shared/lib/query/migration-reindex';

/**
 * Upgrade bridge for existing PAT-1 tenants. It materializes the three VIS encryption
 * maps only in scopes that already use encryption, and preserves preview-era patient
 * numbers as lookup-only aliases while replacing their identifier-derived public value.
 */
export const queryIndexReindexEntityTypes = declareQueryIndexReindex([
  'patient:patient',
]);

const VIS_ENCRYPTION_MAPS = [
  {
    entityId: 'patient:patient_list_projection',
    fields: [
      { field: 'first_name' },
      { field: 'last_name' },
      { field: 'birth_date' },
      { field: 'email' },
      { field: 'phone' },
      { field: 'description' },
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
] as const;

export class Migration20260930182624_patient extends Migration {

  override name = 'Migration20260930182624';

  override up(): void | Promise<void> {
    this.addSql(`alter table "patient_patients" add "legacy_patient_number" text null;`);

    this.addSql(`create unique index "patient_patients_scope_legacy_number_uq" on "patient_patients" ("tenant_id", "organization_id", "legacy_patient_number") where "deleted_at" is null and "legacy_patient_number" is not null;`);
    this.addSql(`update "patient_patients" set "legacy_patient_number" = "patient_number", "patient_number" = 'P-' || gen_random_uuid()::text, "updated_at" = now() where "patient_number" = 'P-' || "id"::text;`);

    for (const map of VIS_ENCRYPTION_MAPS) {
      const fields = JSON.stringify(map.fields).replaceAll("'", "''");
      this.addSql(`insert into "encryption_maps" ("id", "entity_id", "tenant_id", "organization_id", "fields_json", "is_active", "created_at", "updated_at")
        select gen_random_uuid(), '${map.entityId}', src."tenant_id", src."organization_id", '${fields}'::jsonb, true, now(), now()
        from (select distinct "tenant_id", "organization_id" from "encryption_maps" where "is_active" = true and "deleted_at" is null) src
        where not exists (
          select 1 from "encryption_maps" existing
          where existing."entity_id" = '${map.entityId}'
            and existing."tenant_id" is not distinct from src."tenant_id"
            and existing."organization_id" is not distinct from src."organization_id"
            and existing."deleted_at" is null
        );`);
    }
  }

  override down(): void | Promise<void> {
    this.addSql(`update "patient_patients" set "patient_number" = "legacy_patient_number", "updated_at" = now() where "legacy_patient_number" is not null;`);
    this.addSql(`drop index if exists "patient_patients_scope_legacy_number_uq";`);
    this.addSql(`alter table "patient_patients" drop column "legacy_patient_number";`);
    // Keep VIS maps on rollback. `up()` inserts only missing rows, so a map may predate
    // this migration (tenant setup or an operator seed); deleting by entity id would
    // destroy those rows too and make already-encrypted snapshots unreadable.
  }

}
