import { createHmac } from "crypto";
import type { Request } from "express";
import type { QueryRunner } from "typeorm";
import { describe, expect, it, vi } from "vitest";
import { AddWebhookDeliveries1760000000016 } from "../migrations/1760000000016-AddWebhookDeliveries.js";
import {
  extractWebhookDeliveryId,
  hashWebhookPayload,
  processWebhookDelivery,
  registerWebhookProcessor,
  verifyWebhookSignature,
  type WebhookDeliveryStore,
} from "./webhooks.service.js";

class MemoryWebhookStore implements WebhookDeliveryStore {
  readonly deliveries = new Map<
    string,
    {
      status: "processing" | "completed" | "failed";
      attempts: number;
      claimToken: string;
      leaseExpiresAt: number;
    }
  >();

  async claim(provider: string, deliveryId: string, _payloadHash: string, _leaseMs: number) {
    const key = `${provider}:${deliveryId}`;
    const existing = this.deliveries.get(key);
    if (!existing || existing.status === "failed" || existing.leaseExpiresAt <= Date.now()) {
      const attempts = existing ? existing.attempts + 1 : 1;
      const claimToken = `${key}:${attempts}`;
      this.deliveries.set(key, {
        status: "processing",
        attempts,
        claimToken,
        leaseExpiresAt: Date.now() + _leaseMs,
      });
      return {
        claimed: true,
        deliveryId,
        claimToken,
        status: "processing" as const,
        attempts,
      };
    }
    return {
      claimed: false,
      deliveryId,
      claimToken: null,
      status: existing.status,
      attempts: existing.attempts,
    };
  }

  async renew(provider: string, deliveryId: string, claimToken: string, leaseMs: number) {
    const row = this.deliveries.get(`${provider}:${deliveryId}`);
    if (!row || row.status !== "processing" || row.claimToken !== claimToken) return false;
    if (row.leaseExpiresAt <= Date.now()) return false;
    row.leaseExpiresAt = Date.now() + leaseMs;
    return true;
  }

  async complete(provider: string, deliveryId: string, claimToken: string) {
    const key = `${provider}:${deliveryId}`;
    const row = this.deliveries.get(key);
    if (row && row.claimToken === claimToken) row.status = "completed";
  }

  async fail(provider: string, deliveryId: string, claimToken: string, _failureCode: string) {
    const key = `${provider}:${deliveryId}`;
    const row = this.deliveries.get(key);
    if (row && row.claimToken === claimToken) row.status = "failed";
  }
}

describe("webhook signature verification", () => {
  const secret = "test-webhook-signing-secret";
  const raw = Buffer.from('{"event":"payment"}');

  it("accepts a valid raw-body HMAC signature", () => {
    const signature = createHmac("sha256", secret).update(raw).digest("hex");
    expect(verifyWebhookSignature(raw, `sha256=${signature}`, secret)).toBe(true);
  });

  it("rejects invalid and missing signatures", () => {
    expect(verifyWebhookSignature(raw, "sha256=bad", secret)).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, secret)).toBe(false);
  });
});

describe("webhook delivery identity and processing", () => {
  it("enforces delivery uniqueness in the database schema", async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        statements.push(sql);
        return [];
      },
    } as unknown as QueryRunner;

    await new AddWebhookDeliveries1760000000016().up(queryRunner);

    expect(statements.join("\n")).toContain('UNIQUE ("provider", "deliveryId")');
  });

  it("extracts stable IDs from headers and provider payloads", () => {
    const headerReq = {
      header: (name: string) => (name === "x-delivery-id" ? "delivery-1" : undefined),
    } as unknown as Request;
    expect(extractWebhookDeliveryId(headerReq, {})).toBe("delivery-1");

    const bodyReq = { header: () => undefined } as unknown as Request;
    expect(extractWebhookDeliveryId(bodyReq, { eventId: "event-1" })).toBe("event-1");
  });

  it("processes first delivery, acknowledges duplicates, and keeps IDs independent", async () => {
    const store = new MemoryWebhookStore();
    const sideEffect = vi.fn(async () => {});
    registerWebhookProcessor("ussd", sideEffect);
    const raw = Buffer.from('{"event":"payment"}');

    const first = await processWebhookDelivery("ussd", "delivery-1", {}, raw, store);
    const duplicate = await processWebhookDelivery("ussd", "delivery-1", {}, raw, store);
    const different = await processWebhookDelivery("ussd", "delivery-2", {}, raw, store);

    expect(first.outcome).toBe("processed");
    expect(duplicate.outcome).toBe("duplicate");
    expect(different.outcome).toBe("processed");
    expect(sideEffect).toHaveBeenCalledTimes(2);
  });

  it("allows failed deliveries to be retried safely", async () => {
    const store = new MemoryWebhookStore();
    const raw = Buffer.from('{"event":"retry"}');
    const processor = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    registerWebhookProcessor("sms", processor);

    await expect(processWebhookDelivery("sms", "retry-1", {}, raw, store)).rejects.toThrow(
      "transient"
    );
    const retry = await processWebhookDelivery("sms", "retry-1", {}, raw, store);

    expect(retry.outcome).toBe("processed");
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent claims to one processor execution", async () => {
    const store = new MemoryWebhookStore();
    const raw = Buffer.from('{"event":"concurrent"}');
    const processor = vi.fn(async () => {});
    registerWebhookProcessor("parallel", processor);

    const [a, b] = await Promise.all([
      processWebhookDelivery("parallel", "same-id", {}, raw, store),
      processWebhookDelivery("parallel", "same-id", {}, raw, store),
    ]);

    expect(a.outcome).not.toBe(b.outcome);
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it("renews long-running claims so a duplicate cannot start after the initial lease", async () => {
    const store = new MemoryWebhookStore();
    const raw = Buffer.from('{"event":"long"}');
    let finishProcessing!: () => void;
    const processor = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProcessing = resolve;
        })
    );
    registerWebhookProcessor("long-running", processor);

    const first = processWebhookDelivery("long-running", "same-id", {}, raw, store, 60);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const duplicate = await processWebhookDelivery("long-running", "same-id", {}, raw, store, 60);
    finishProcessing();

    expect((await first).outcome).toBe("processed");
    expect(duplicate.outcome).toBe("duplicate");
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it("allows an expired processing claim to recover without letting the stale owner finish it", async () => {
    const store = new MemoryWebhookStore();
    const firstClaim = await store.claim("recover", "interrupted", "hash", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const retryClaim = await store.claim("recover", "interrupted", "hash", 100);

    expect(firstClaim.claimed).toBe(true);
    expect(retryClaim.claimed).toBe(true);
    expect(retryClaim.claimToken).not.toBe(firstClaim.claimToken);

    await store.complete("recover", "interrupted", firstClaim.claimToken!);
    expect(store.deliveries.get("recover:interrupted")?.status).toBe("processing");
  });

  it("hashes payloads without storing their sensitive contents", () => {
    const hash = hashWebhookPayload(Buffer.from("secret payload"));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
