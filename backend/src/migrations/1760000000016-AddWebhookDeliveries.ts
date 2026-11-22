import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWebhookDeliveries1760000000016 implements MigrationInterface {
  name = "AddWebhookDeliveries1760000000016";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "webhook_delivery_status_enum" AS ENUM (
        'processing', 'completed', 'failed'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "webhook_deliveries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "provider" character varying(64) NOT NULL,
        "deliveryId" character varying(256) NOT NULL,
        "payloadHash" character varying(64) NOT NULL,
        "status" "webhook_delivery_status_enum" NOT NULL DEFAULT 'processing',
        "attempts" integer NOT NULL DEFAULT 1,
        "processingStartedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "leaseExpiresAt" TIMESTAMPTZ NOT NULL,
        "completedAt" TIMESTAMPTZ,
        "failedAt" TIMESTAMPTZ,
        "failureCode" text,
        CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_webhook_deliveries_provider_delivery"
          UNIQUE ("provider", "deliveryId")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_webhook_deliveries_status_lease"
        ON "webhook_deliveries" ("status", "leaseExpiresAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_webhook_deliveries_status_lease"`);
    await queryRunner.query(`DROP TABLE "webhook_deliveries"`);
    await queryRunner.query(`DROP TYPE "webhook_delivery_status_enum"`);
  }
}
