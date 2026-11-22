import express from "express";
import request from "supertest";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { errorHandler, notFoundHandler } from "../error.js";
import { requestIdMiddleware } from "../request-id.js";
import { validateRequest } from "../validate.js";
import { withResponseValidation } from "../validateResponse.js";
import { authJwtMiddleware } from "../auth-jwt.js";
import { requirePaymentsAdminAccess, enforcePaymentsAdminWriteEnabled } from "../payments-admin.js";
import { clearEnvCache } from "../../config/env.js";
import { collaborationRouter, setProjectRoleContextResolver } from "../../routes/collaboration.js";
import { AppError, ErrorCode, ErrorType } from "../../lib/errors.js";
import { generateOpenApi } from "../../openapi.js";

vi.mock("../../services/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const owner = Keypair.random().publicKey();
const payloadSchema = z.object({ name: z.string().min(1) });

function createApp(withRequestId = true) {
  const app = express();
  if (withRequestId) app.use(requestIdMiddleware);
  app.use(express.json());
  app.post("/validation/middleware", validateRequest({ body: payloadSchema }), (_req, res) =>
    res.json({ ok: true })
  );
  app.post("/validation/route", (req, res) => res.json(payloadSchema.parse(req.body)));
  app.get("/protected", authJwtMiddleware, (_req, res) => res.json({ ok: true }));
  app.post("/admin", requirePaymentsAdminAccess, enforcePaymentsAdminWriteEnabled, (_req, res) =>
    res.json({ ok: true })
  );
  app.get(
    "/invalid-response",
    withResponseValidation(payloadSchema, (_req, res) => res.json({ invalid: true }))
  );
  app.get("/domain/:type/:code", (req) => {
    throw new AppError(
      req.params.type as ErrorType,
      req.params.code as ErrorCode,
      "Domain failure."
    );
  });
  app.use("/collaboration", collaborationRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function expectEnvelope(response: request.Response, error: string, code = error.toUpperCase()) {
  expect(response.body).toMatchObject({
    error,
    code,
    message: expect.any(String),
    requestId: expect.any(String),
    details: expect.any(Object),
  });
  expect(response.body.message.length).toBeGreaterThan(0);
  expect(response.body.requestId.length).toBeGreaterThan(0);
  expect(response.headers["x-request-id"]).toBe(response.body.requestId);
  expect(Array.isArray(response.body.details)).toBe(false);
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearEnvCache();
});

describe("Issue #2: common API error contract", () => {
  it("returns identical validation errors for middleware and route parsing", async () => {
    const app = createApp();
    const middleware = await request(app)
      .post("/validation/middleware")
      .set("X-Request-ID", "validation-test")
      .send({})
      .expect(400);
    const route = await request(app)
      .post("/validation/route")
      .set("X-Request-ID", "validation-test")
      .send({})
      .expect(400);
    expectEnvelope(middleware, "validation_error");
    expect(middleware.body).toEqual(route.body);
    expect(middleware.body.details.fieldErrors.name).toBeDefined();
  });

  it.each([true, false])(
    "correlates auth, parser and not-found errors (request-ID middleware: %s)",
    async (withRequestId) => {
      const app = createApp(withRequestId);
      expectEnvelope(await request(app).get("/protected").expect(401), "unauthorized");
      expectEnvelope(await request(app).get("/missing").expect(404), "not_found");
      expectEnvelope(
        await request(app)
          .post("/validation/route")
          .set("Content-Type", "application/json")
          .send("{")
          .expect(400),
        "invalid_json"
      );
    }
  );

  it("uses the envelope for admin authentication and disabled writes, preserving metadata", async () => {
    vi.stubEnv("PAYMENTS_ADMIN_API_KEY", "test-admin-key");
    vi.stubEnv("PAYMENTS_ADMIN_WRITE_ENABLED", "false");
    clearEnvCache();
    const app = createApp();
    expectEnvelope(await request(app).post("/admin").expect(401), "admin_auth_required");
    const disabled = await request(app)
      .post("/admin")
      .set("x-admin-api-key", "test-admin-key")
      .expect(503);
    expectEnvelope(disabled, "payments_admin_writes_disabled");
    expect(disabled.body.details).toEqual({ rollbackAware: true });
  });

  it("preserves permission metadata and standardizes collaboration not-found errors", async () => {
    setProjectRoleContextResolver(async () => ({ owner, collaborators: [] }));
    const app = createApp();
    const denied = await request(app)
      .post("/collaboration/projects/p/invitations")
      .set("X-Stellar-Address", Keypair.random().publicKey())
      .send({})
      .expect(403);
    expectEnvelope(denied, "permission_denied");
    expect(denied.body.permission).toBe("project:invite");
    const missing = await request(app)
      .post("/collaboration/invitations/missing/cancel")
      .set("X-Stellar-Address", owner)
      .send({})
      .expect(404);
    expectEnvelope(missing, "invitation_not_found");
  });

  it("uses the envelope when strict success-response validation fails", async () => {
    vi.stubEnv("STRICT_RESPONSE_VALIDATION", "true");
    expectEnvelope(
      await request(createApp(false)).get("/invalid-response").expect(500),
      "internal_error"
    );
  });

  it.each([
    [ErrorType.CONTRACT, ErrorCode.INVALID_SPLIT, 400],
    [ErrorType.CONTRACT, ErrorCode.PROJECT_EXISTS, 409],
    [ErrorType.CONTRACT, ErrorCode.DISTRIBUTIONS_PAUSED, 409],
    [ErrorType.RPC, ErrorCode.RPC_CONNECTIVITY, 502],
    [ErrorType.INTERNAL, ErrorCode.INTERNAL_ERROR, 500],
  ])("maps %s/%s to HTTP %s", async (type, code, status) => {
    const response = await request(createApp()).get(`/domain/${type}/${code}`).expect(status);
    expectEnvelope(response, code.toLowerCase(), code);
  });

  it("documents every common envelope field as required", () => {
    const spec = generateOpenApi();
    const schema = spec.components?.schemas?.ApiError;
    expect(schema).toHaveProperty(
      "required",
      expect.arrayContaining(["error", "code", "message", "requestId", "details"])
    );
  });
});
