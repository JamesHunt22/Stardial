import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from "typeorm";

export const WEBHOOK_DELIVERY_STATUSES = ["processing", "completed", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

@Entity("webhook_deliveries")
@Unique("UQ_webhook_deliveries_provider_delivery", ["provider", "deliveryId"])
@Index("IDX_webhook_deliveries_status_lease", ["status", "leaseExpiresAt"])
export class WebhookDelivery {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  provider!: string;

  @Column({ type: "varchar", length: 256 })
  deliveryId!: string;

  @Column({ type: "varchar", length: 64 })
  payloadHash!: string;

  @Column({ type: "uuid", nullable: true })
  claimToken!: string | null;

  @Column({
    type: "enum",
    enum: WEBHOOK_DELIVERY_STATUSES,
    default: "processing",
  })
  status!: WebhookDeliveryStatus;

  @Column({ type: "integer", default: 1 })
  attempts!: number;

  @Column({ type: "timestamptz", default: () => "now()" })
  processingStartedAt!: Date;

  @Column({ type: "timestamptz" })
  leaseExpiresAt!: Date;

  @Column({ type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  failedAt!: Date | null;

  @Column({ type: "text", nullable: true })
  failureCode!: string | null;
}
