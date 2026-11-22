/**
 * Issue #5: shared request validation for high-risk API endpoints.
 *
 * Each endpoint gets a valid-request check plus malformed input cases. All
 * service mocks are cleared per test so a 400 from the shared middleware can
 * be proven to happen before a database query, webhook claim or event bus
 * subscription.
 */
import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error.js";
import {
  assetCodeSchema,
  positiveAmountSchema,
  stellarAccountIdSchema,
  textMemoSchema,
} from "../schemas/api-input.schemas.js";

const mocks = vi.hoisted(() => ({
  getPayoutByTxHash: vi.fn(),
  searchPayouts: vi.fn(),
  getPayoutsPage: vi.fn(),
  findOne: vi.fn(),
  getSseEventBus: vi.fn(),
  getEventBus: vi.fn(),
  extractWebhookDeliveryId: vi.fn(),
  getWebhookSigningSecret: vi.fn(),
  normalizeProvider: vi.fn((provider: string) => provider.trim().toLowerCase()),
  processWebhookDelivery: vi.fn(),
  verifyWebhookSignature: vi.fn(),
}));

vi.mock("../services/PayoutHistoryService.js", () => ({
  createPayoutHistoryService: () => ({
    getPayoutByTxHash: mocks.getPayoutByTxHash,
    searchPayouts: mocks.searchPayouts,
    getPayoutsPage: mocks.getPayoutsPage,
    getPayoutsWithCount: vi.fn(),
  }),
}));

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({ getRepository: () => ({ findOne: mocks.findOne }) }),
  withTransaction: vi.fn(),
}));

vi.mock("../services/webhooks.service.js", () => ({
  extractWebhookDeliveryId: mocks.extractWebhookDeliveryId,
  getWebhookSigningSecret: mocks.getWebhookSigningSecret,
  normalizeProvider: mocks.normalizeProvider,
  processWebhookDelivery: mocks.processWebhookDelivery,
  verifyWebhookSignature: mocks.verifyWebhookSignature,
}));

vi.mock("../services/SseEventBus.js", () => ({
  getSseEventBus: mocks.getSseEventBus,
  getSseEventName: (key: string) => `sse:${key}`,
}));

vi.mock("../services/EventBus.js", () => ({
  getEventBus: mocks.getEventBus,
  TRANSACTION_CONFIRMED: "transaction:confirmed",
}));

vi.mock("../services/metrics.js", () => ({
  incrementSseConnections: vi.fn(),
  recordSseDisconnect: vi.fn(),
}));

vi.mock("../services/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../config/env.js", () => ({
  getEnv: () => ({ SOROBAN_NETWORK_PASSPHRASE: "test-network" }),
}));

import { transactionsRouter } from "../routes/transactions.js";
import { usersRouter } from "../routes/users.js";
import { webhooksRouter } from "../routes/webhooks.js";
import { eventsRouter } from "../routes/events.js";

const HASH = "a".repeat(64);
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const HOSTILE = "' OR 1=1 --";
const XSS = "<script>alert(1)</script>";

function createApp(router: express.Router, mount: string) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, body) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(body);
      },
    })
  );
  app.use(mount, router);
  app.use(errorHandler);
  return app;
}

const transactionsApp = createApp(transactionsRouter, "/transactions");
const usersApp = createApp(usersRouter, "/users");
const webhooksApp = createApp(webhooksRouter, "/webhooks");
const eventsApp = createApp(eventsRouter, "/events");

function expectValidation400(response: request.Response, field?: string) {
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({
    error: "validation_error",
    code: "VALIDATION_ERROR",
    message: expect.any(String),
    requestId: expect.any(String),
  });
  expect(response.body.details).toEqual({
    fieldErrors: expect.any(Object),
    formErrors: expect.any(Array),
  });
  if (field) {
    expect(response.body.details.fieldErrors).toHaveProperty(field);
  }
  const serialized = JSON.stringify(response.body);
  expect(serialized).not.toContain(HOSTILE);
  expect(serialized).not.toContain(XSS);
  expect(serialized).not.toMatch(/\bat\s+\S+:\d+:\d+/); // no stack frames
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWebhookSigningSecret.mockReturnValue("test-webhook-secret");
  mocks.verifyWebhookSignature.mockReturnValue(true);
  mocks.extractWebhookDeliveryId.mockReturnValue(null);
  mocks.processWebhookDelivery.mockResolvedValue({ outcome: "processed" });
});

describe("GET /transactions/receipt/:txHash", () => {
  it("accepts a 64-character hex hash and returns the existing receipt", async () => {
    mocks.getPayoutByTxHash.mockResolvedValue({
      txHash: HASH,
      amount: "1000",
      token: "native",
      timestamp: 1_700_000_000,
      status: "completed",
      recipient: WALLET,
      roundId: "round-1",
    });

    const response = await request(transactionsApp).get(`/transactions/receipt/${HASH}`);

    expect(response.status).toBe(200);
    expect(mocks.getPayoutByTxHash).toHaveBeenCalledWith(HASH);
  });

  it.each([
    ["malformed format", "not-a-hash"],
    ["out of range (65 chars)", `${HASH}0`],
    ["oversized string", `${HASH}${"0".repeat(1000)}`],
    ["hostile/injection string", encodeURIComponent(HOSTILE)],
    ["XSS string", encodeURIComponent(XSS)],
  ])("rejects a %s hash before querying", async (_label, hash) => {
    const response = await request(transactionsApp).get(`/transactions/receipt/${hash}`);
    expectValidation400(response, "txHash");
    expect(mocks.getPayoutByTxHash).not.toHaveBeenCalled();
  });

  it("rejects an undocumented query field", async () => {
    const response = await request(transactionsApp).get(`/transactions/receipt/${HASH}?debug=true`);
    expectValidation400(response);
    expect(mocks.getPayoutByTxHash).not.toHaveBeenCalled();
  });
});

describe("GET /transactions/:txHash", () => {
  it("accepts a valid hash and returns the existing transaction", async () => {
    const record = { txHash: HASH, status: "completed" };
    mocks.searchPayouts.mockResolvedValue([record]);

    const response = await request(transactionsApp).get(`/transactions/${HASH}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(record);
    expect(mocks.searchPayouts).toHaveBeenCalledWith(HASH);
  });

  it.each([
    ["malformed format (too short)", HASH.slice(0, 63)],
    ["malformed format (non-hex)", `${HASH.slice(0, 63)}z`],
    ["oversized string", `${HASH}${"0".repeat(1000)}`],
    ["hostile/injection string", encodeURIComponent(HOSTILE)],
    ["XSS string", encodeURIComponent(XSS)],
  ])("rejects a %s hash before searching", async (_label, hash) => {
    const response = await request(transactionsApp).get(`/transactions/${hash}`);
    expectValidation400(response, "txHash");
    expect(mocks.searchPayouts).not.toHaveBeenCalled();
  });

  it("rejects unexpected query input", async () => {
    const response = await request(transactionsApp).get(`/transactions/${HASH}?${XSS}=1`);
    expectValidation400(response);
    expect(mocks.searchPayouts).not.toHaveBeenCalled();
  });
});

describe("GET /transactions/recipient/:walletAddress", () => {
  it("accepts a valid Stellar address and page controls", async () => {
    mocks.getPayoutsPage.mockResolvedValue({
      records: [],
      total: 0,
      hasMore: false,
    });

    const response = await request(transactionsApp)
      .get(`/transactions/recipient/${WALLET}`)
      .query({ limit: 2, offset: 0 });

    expect(response.status).toBe(200);
    expect(mocks.getPayoutsPage).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: WALLET, limit: 2, offset: 0 })
    );
  });

  it.each([
    ["malformed format", "INVALID"],
    ["oversized string", "G".repeat(1000)],
    ["hostile/injection string", encodeURIComponent(HOSTILE)],
    ["XSS string", encodeURIComponent(XSS)],
  ])("rejects a %s before querying", async (_label, address) => {
    const response = await request(transactionsApp).get(`/transactions/recipient/${address}`);
    expectValidation400(response, "walletAddress");
    expect(mocks.getPayoutsPage).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong type", "limit", "abc"],
    ["wrong type (repeated param)", "limit", undefined],
    ["out of range", "limit", "101"],
    ["oversized string", "cursor", "x".repeat(513)],
    ["hostile/injection string", "cursor", HOSTILE],
    ["unknown field", "unexpected", "1"],
  ])("rejects %s query input", async (_label, key, value) => {
    const path = key === "limit" && value === undefined
      ? `/transactions/recipient/${WALLET}?limit=1&limit=2`
      : `/transactions/recipient/${WALLET}`;
    const req = request(transactionsApp).get(path);
    if (value !== undefined) req.query({ [key]: value });
    const response = await req;
    expectValidation400(response);
    expect(mocks.getPayoutsPage).not.toHaveBeenCalled();
  });
});

describe("GET /users/:walletAddress", () => {
  const user = {
    id: "22222222-2222-4222-8222-222222222222",
    walletAddress: WALLET,
    email: null,
    alias: "Test",
    role: "customer",
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("accepts a StrKey-valid G address", async () => {
    mocks.findOne.mockResolvedValue(user);

    const response = await request(usersApp).get(`/users/${WALLET}`);

    expect(response.status).toBe(200);
    expect(mocks.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({ walletAddress: WALLET }),
    });
  });

  it.each([
    ["malformed format", "G" + "A".repeat(55)],
    ["out of range (57 chars)", `${WALLET}A`],
    ["oversized string", `${WALLET}${"A".repeat(1000)}`],
    ["hostile/injection string", encodeURIComponent(HOSTILE)],
    ["XSS string", encodeURIComponent(XSS)],
  ])("rejects a %s before the DB lookup", async (_label, address) => {
    const response = await request(usersApp).get(`/users/${address}`);
    expectValidation400(response, "walletAddress");
    expect(mocks.findOne).not.toHaveBeenCalled();
  });

  it("rejects unexpected query input", async () => {
    const response = await request(usersApp).get(`/users/${WALLET}?debug=1`);
    expectValidation400(response);
    expect(mocks.findOne).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/:provider (and /v1 alias)", () => {
  function postWebhook(app: express.Express, path = "/webhooks/paystack") {
    return request(app)
      .post(path)
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", "sha256=signature")
      .set("x-webhook-id", "delivery-1")
      .send({ event: "payment" });
  }

  it("accepts a valid provider, signature and delivery ID", async () => {
    const response = await postWebhook(webhooksApp);
    expect(response.status).toBe(200);
    expect(mocks.processWebhookDelivery).toHaveBeenCalledWith(
      "paystack",
      "delivery-1",
      { event: "payment" },
      Buffer.from('{"event":"payment"}')
    );
  });

  it.each([
    ["malformed format (provider)", "/webhooks/not+a+provider", "signature", "delivery-1"],
    ["oversized string (provider)", `/webhooks/${"a".repeat(65)}`, "signature", "delivery-1"],
    ["malformed format (signature)", "/webhooks/paystack", XSS, "delivery-1"],
    ["oversized string (signature)", "/webhooks/paystack", "s".repeat(513), "delivery-1"],
    ["hostile/injection string (delivery ID)", "/webhooks/paystack", "signature", HOSTILE],
    ["oversized string (delivery ID)", "/webhooks/paystack", "signature", "d".repeat(257)],
  ])("rejects a %s before the webhook claim", async (_label, path, signature, deliveryId) => {
    const response = await request(webhooksApp)
      .post(path)
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", signature)
      .set("x-webhook-id", deliveryId)
      .send({ event: "payment" });
    expectValidation400(response);
    expect(mocks.processWebhookDelivery).not.toHaveBeenCalled();
  });

  it("rejects a hostile delivery ID coming from the payload", async () => {
    mocks.extractWebhookDeliveryId.mockReturnValue(HOSTILE);
    const response = await request(webhooksApp)
      .post("/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", "signature")
      .send({ event: "payment" });

    expectValidation400(response, "deliveryId");
    expect(mocks.processWebhookDelivery).not.toHaveBeenCalled();
  });

  it("ignores unknown headers safely rather than reflecting them", async () => {
    const response = await postWebhook(webhooksApp).set("x-unexpected", XSS);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(XSS);
    expect(mocks.processWebhookDelivery).toHaveBeenCalledOnce();
  });
});

describe("SSE input validation", () => {
  it("rejects a missing txHash query parameter", async () => {
    const response = await request(eventsApp).get("/events");
    expectValidation400(response, "txHash");
    expect(mocks.getSseEventBus).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong type (repeated param)", "?txHash=one&txHash=two"],
    ["out of range", `?txHash=${"a".repeat(129)}`],
    ["oversized string", `?txHash=${"a".repeat(1000)}`],
    ["malformed format", `?txHash=${encodeURIComponent("not a key!")}`],
    ["hostile/injection string", `?txHash=${encodeURIComponent(HOSTILE)}`],
    ["XSS string", `?txHash=${encodeURIComponent(XSS)}`],
    ["unknown field", "?txHash=valid&debug=1"],
  ])("rejects %s before subscribing", async (_label, query) => {
    const response = await request(eventsApp).get(`/events${query}`);
    expectValidation400(response);
    expect(mocks.getSseEventBus).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed format", encodeURIComponent(XSS)],
    ["out of range", "a".repeat(129)],
    ["oversized string", "a".repeat(1000)],
    ["hostile/injection string", encodeURIComponent(HOSTILE)],
    ["path traversal", "..%2Fetc%2Fpasswd"],
    ["unknown field in query", "valid?debug=1"],
  ])("rejects a %s stream key before subscribing", async (_label, key) => {
    const response = await request(eventsApp).get(`/events/transactions/${key}`);
    expectValidation400(response);
    expect(mocks.getEventBus).not.toHaveBeenCalled();
  });
});

describe("shared Stellar primitives", () => {
  it("validates classic G addresses with the StrKey checksum", () => {
    expect(stellarAccountIdSchema.safeParse(WALLET).success).toBe(true);
    expect(stellarAccountIdSchema.safeParse(` ${WALLET} `).data).toBe(WALLET);
    expect(stellarAccountIdSchema.safeParse("G" + "A".repeat(55)).success).toBe(false);
    expect(stellarAccountIdSchema.safeParse(XSS).success).toBe(false);
  });

  it("accepts only positive, bounded, 7-decimal amounts", () => {
    expect(positiveAmountSchema.parse("0.0000001")).toBe("0.0000001");
    expect(positiveAmountSchema.safeParse("0").success).toBe(false);
    expect(positiveAmountSchema.safeParse("1.12345678").success).toBe(false);
    expect(positiveAmountSchema.safeParse("-1").success).toBe(false);
    expect(positiveAmountSchema.safeParse("1e3").success).toBe(false);
  });

  it("constrains asset codes and text memos", () => {
    expect(assetCodeSchema.safeParse("USDC").success).toBe(true);
    expect(assetCodeSchema.safeParse("TOKENLONGERTHAN12").success).toBe(false);
    expect(textMemoSchema.safeParse("invoice-42").success).toBe(true);
    expect(textMemoSchema.safeParse("x".repeat(29)).success).toBe(false);
    expect(textMemoSchema.safeParse("line\nbreak").success).toBe(false);
  });
});
