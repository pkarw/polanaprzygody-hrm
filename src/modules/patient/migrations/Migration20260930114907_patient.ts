import { Migration } from '@mikro-orm/migrations';

export class Migration20260930114907_patient extends Migration {

  override name = 'Migration20260930114907';

  override up(): void | Promise<void> {
    this.addSql(`create view "patient_patient_list_projection" as select
      p.id,
      p.tenant_id,
      p.organization_id,
      p.patient_number,
      p.first_name,
      p.last_name,
      p.birth_date,
      p.email,
      p.phone,
      p.description,
      p.owner_team_member_id,
      p.status,
      p.archived_at,
      p.created_at,
      p.updated_at,
      p.deleted_at,
      (
        select v.starts_at
        from patient_visits v
        where v.tenant_id = p.tenant_id
          and v.organization_id = p.organization_id
          and v.patient_id = p.id
          and v.status = 'planned'
          and v.starts_at >= current_timestamp
          and v.deleted_at is null
        order by v.starts_at asc, v.id asc
        limit 1
      ) as next_visit_at
    from patient_patients p;`);
  }

}
