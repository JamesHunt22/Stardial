import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { Request } from "express";
import { withTransaction } from "./database.js";

export interface WebhookClaim {
  claimed: boolean;
  deliveryId: string;
  claimToken: string | null;
  status: "processing" | "completed" | "failed";
  attempts: number;
}

export interface WebhookProcessor {
  (provider: string, deliveryId: string, payload: unknown): Promise<void>;
}

export interface WebhookDeliveryStore {
  claim(
    provider: string,
    deliveryId: string,
    payloadHash: string,
    leaseMs: number
  ): Promise<WebhookClaim>;
  renew(
    provider: string,
    deliveryId: string,
    claimToken: string,
    leaseMs: number
  ): Promise<boolean>;
  complete(provider: string, deliveryId: string, claimToken: string): Promise<void>;
  fail(
    provider: string,
    deliveryId: string,
    claimToken: string,
    failureCode: string
  ): Promise<void>;
}

const processors = new Map<string, WebhookProcessor>();

export function registerWebhookProcessor(provider: string, processor: WebhookProcessor): void {
  const normalized = normalizeProvider(provider);
  processors.set(normalized, processor);
}

export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

export function extractWebhookDeliveryId(req: Request, payload: unknown): string | null {
  const headers = [
    req.header("x-webhook-id"),
    req.header("x-delivery-id"),
    req.header("x-event-id"),
  ];
  for (const value of headers) {
    if (typeof value === "string" && value.trim().length > 0 && value.trim().length <= 256) {
      return value.trim();
    }
  }

  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["delivery_id", "deliveryId", "event_id", "eventId", "id", "messageId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0 && value.trim().length <= 256) {
      return value.trim();
    }
  }
  return null;
}

export function getWebhookSigningSecret(provider: string): string | null {
  const normalized = normalizeProvider(provider);
  const providerSecrets = process.env.WEBHOOK_SIGNING_SECRETS;
  if (providerSecrets) {
    try {
      const parsed = JSON.parse(providerSecrets) as unknown;
      if (parsed && typeof parsed === "object") {
        const value = (parsed as Record<string, unknown>)[normalized];
        if (typeof value === "string" && value.length >= 16) return value;
      }
    } catch {
      return null;
    }
  }

  const envName = `${normalized.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_WEBHOOK_SIGNING_SECRET`;
  const providerSecret = process.env[envName];
  if (providerSecret && providerSecret.length >= 16) return providerSecret;

  const sharedSecret = process.env.WEBHOOK_SIGNING_SECRET;
  return sharedSecret && sharedSecret.length >= 16 ? sharedSecret : null;
}

export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  const raw = signatureHeader.trim();
  const signatures = raw
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) => (entry.startsWith("sha256=") ? entry.slice("sha256=".length) : entry))
    .filter((entry) => /^[a-fA-F0-9]{64}$/.test(entry));

  if (signatures.length === 0) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  return signatures.some((signature) => {
    const supplied = Buffer.from(signature, "hex");
    return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
  });
}

export function hashWebhookPayload(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  async claim(
    provider: string,
    deliveryId: string,
    payloadHash: string,
    leaseMs: number
  ): Promise<WebhookClaim> {
    const claimToken = randomUUID();
    return withTransaction(async (queryRunner) => {
      const result = await queryRunner.query(
        `
          INSERT INTO "webhook_deliveries"
            ("provider", "deliveryId", "payloadHash", "claimToken", "status", "attempts",
             "processingStartedAt", "leaseExpiresAt")
          VALUES ($1, $2, $3, $4, 'processing', 1, now(), now() + ($5 * interval '1 millisecond'))
          ON CONFLICT ("provider", "deliveryId") DO UPDATE
          SET "status" = 'processing',
              "payloadHash" = EXCLUDED."payloadHash",
              "claimToken" = EXCLUDED."claimToken",
              "attempts" = "webhook_deliveries"."attempts" + 1,
              "processingStartedAt" = now(),
              "leaseExpiresAt" = now() + ($5 * interval '1 millisecond'),
              "failedAt" = NULL,
              "failureCode" = NULL
          WHERE "webhook_deliveries"."status" = 'failed'
             OR ("webhook_deliveries"."status" = 'processing'
                 AND "webhook_deliveries"."leaseExpiresAt" <= now())
          RETURNING "status", "attempts"
        `,
        [provider, deliveryId, payloadHash, claimToken, leaseMs]
      );

      if (result.length === 1) {
        return {
          claimed: true,
          deliveryId,
          claimToken,
          status: "processing",
          attempts: Number(result[0].attempts),
        };
      }
      const existing = await queryRunner.query(
        `SELECT "status", "attempts" FROM "webhook_deliveries"
         WHERE "provider" = $1 AND "deliveryId" = $2`,
        [provider, deliveryId]
      );
      const row = existing[0] as {
        status: "processing" | "completed" | "failed";
        attempts: number;
      };
      return {
        claimed: false,
        deliveryId,
        claimToken: null,
        status: row.status,
        attempts: Number(row.attempts),
      };
    });
  }

  async renew(
    provider: string,
    deliveryId: string,
    claimToken: string,
    leaseMs: number
  ): Promise<boolean> {
    return withTransaction(async (queryRunner) => {
      const result = await queryRunner.query(
        `UPDATE "webhook_deliveries"
         SET "leaseExpiresAt" = now() + ($4 * interval '1 millisecond')
         WHERE "provider" = $1 AND "deliveryId" = $2 AND "claimToken" = $3
           AND "status" = 'processing' AND "leaseExpiresAt" > now()
         RETURNING 1`,
        [provider, deliveryId, claimToken, leaseMs]
      );
      return result.length === 1;
    });
  }

  async complete(provider: string, deliveryId: string, claimToken: string): Promise<void> {
    await withTransaction(async (queryRunner) => {
      const result = await queryRunner.query(
        `UPDATE "webhook_deliveries"
         SET "status" = 'completed', "completedAt" = now(), "failedAt" = NULL
         WHERE "provider" = $1 AND "deliveryId" = $2 AND "claimToken" = $3
           AND "status" = 'processing' AND "leaseExpiresAt" > now()
         RETURNING 1`,
        [provider, deliveryId, claimToken]
      );
      if (result.length !== 1)
        throw new Error("Webhook delivery claim was lost before completion.");
    });
  }

  async fail(
    provider: string,
    deliveryId: string,
    claimToken: string,
    failureCode: string
  ): Promise<void> {
    await withTransaction(async (queryRunner) => {
      await queryRunner.query(
        `UPDATE "webhook_deliveries"
         SET "status" = 'failed', "failedAt" = now(), "failureCode" = $4
         WHERE "provider" = $1 AND "deliveryId" = $2 AND "claimToken" = $3
           AND "status" = 'processing' AND "leaseExpiresAt" > now()`,
        [provider, deliveryId, claimToken, failureCode]
      );
    });
  }
}

export const postgresWebhookDeliveryStore = new PostgresWebhookDeliveryStore();

export async function processWebhookDelivery(
  provider: string,
  deliveryId: string,
  payload: unknown,
  rawBody: Buffer,
  store: WebhookDeliveryStore = postgresWebhookDeliveryStore,
  leaseMs = 30_000
): Promise<{ outcome: "processed" | "duplicate"; claim: WebhookClaim }> {
  const normalized = normalizeProvider(provider);
  const claim = await store.claim(normalized, deliveryId, hashWebhookPayload(rawBody), leaseMs);
  if (!claim.claimed) return { outcome: "duplicate", claim };

  const claimToken = claim.claimToken;
  if (!claimToken) throw new Error("Webhook delivery claim has no ownership token.");

  let heartbeatError: unknown;
  let renewalInFlight: Promise<void> | null = null;
  const heartbeat = setInterval(
    () => {
      if (renewalInFlight) return;
      renewalInFlight = store
        .renew(normalized, deliveryId, claimToken, leaseMs)
        .then((renewed) => {
          if (!renewed) {
            heartbeatError = new Error("Webhook delivery claim was lost during processing.");
          }
        })
        .catch((error: unknown) => {
          heartbeatError = error;
        })
        .finally(() => {
          renewalInFlight = null;
        });
    },
    Math.max(1, Math.floor(leaseMs / 3))
  );
  heartbeat.unref();

  try {
    const processor = processors.get(normalized);
    if (processor) await processor(normalized, deliveryId, payload);
    clearInterval(heartbeat);
    if (renewalInFlight) await renewalInFlight;
    if (heartbeatError) throw heartbeatError;
    await store.complete(normalized, deliveryId, claimToken);
    return { outcome: "processed", claim };
  } catch (error) {
    clearInterval(heartbeat);
    if (renewalInFlight) await renewalInFlight;
    const code = error instanceof Error && error.name ? error.name : "PROCESSING_FAILED";
    await store.fail(normalized, deliveryId, claimToken, code.slice(0, 128));
    throw error;
  }
}
