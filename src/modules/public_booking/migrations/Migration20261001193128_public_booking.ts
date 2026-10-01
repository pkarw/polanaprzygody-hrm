import { Migration } from '@mikro-orm/migrations';

export class Migration20261001193128_public_booking extends Migration {

  override name = 'Migration20261001193128';

  override up(): void | Promise<void> {
    this.addSql(`alter table "public_booking_intakes" add "confirmation_email_delivery_status" text null, add "confirmation_email_claimed_at" timestamptz null, add "confirmation_email_failed_at" timestamptz null, add "confirmation_email_failure_code" text null;`);
    this.addSql(`update "public_booking_intakes" set "confirmation_email_delivery_status" = 'sent' where "confirmation_email_sent_at" is not null;`);
    this.addSql(`alter table "public_booking_intakes" add constraint "public_booking_intakes_confirmation_email_status_chk" check ("confirmation_email_delivery_status" is null or "confirmation_email_delivery_status" in ('pending', 'sending', 'sent', 'failed', 'ambiguous'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "public_booking_intakes" drop constraint if exists "public_booking_intakes_confirmation_email_status_chk";`);
    this.addSql(`alter table "public_booking_intakes" drop column "confirmation_email_delivery_status", drop column "confirmation_email_claimed_at", drop column "confirmation_email_failed_at", drop column "confirmation_email_failure_code";`);
  }

}
