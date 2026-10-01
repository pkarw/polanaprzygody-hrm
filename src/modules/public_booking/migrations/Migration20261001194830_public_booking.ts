import { Migration } from '@mikro-orm/migrations';

export class Migration20261001194830_public_booking extends Migration {

  override name = 'Migration20261001194830';

  override up(): void | Promise<void> {
    this.addSql(`alter table "public_booking_intakes" add "confirmation_email_claim_job_id" text null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "public_booking_intakes" drop column "confirmation_email_claim_job_id";`);
  }

}
