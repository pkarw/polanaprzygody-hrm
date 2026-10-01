import { Migration } from '@mikro-orm/migrations';

export class Migration20261001194830_patient extends Migration {

  override name = 'Migration20261001194830';

  override up(): void | Promise<void> {
    this.addSql(`alter table "patient_visit_payment_email_deliveries" add "claim_job_id" text null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "patient_visit_payment_email_deliveries" drop column "claim_job_id";`);
  }

}
