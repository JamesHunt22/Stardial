import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWebhookClaimToken1760000000017 implements MigrationInterface {
  name = "AddWebhookClaimToken1760000000017";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "webhook_deliveries"
        ADD COLUMN "claimToken" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "webhook_deliveries"
        DROP COLUMN "claimToken"
    `);
  }
}
