import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import { ZodError } from "zod";
import { AppError, ErrorCode, ErrorType } from "../lib/errors.js";
import { logger } from "../services/logger.js";
import { RpcError, RpcTimeoutError } from "../services/stellar.js";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Issue #4: error `details` are developer metadata, not API surface.
 *
 * `AppError.details` is populated at throw sites with whatever aids
 * debugging — upstream exception objects, raw node/Soroban messages, and in
 * the past literal `stack` strings. Spreading it into the response body
 * leaked file names, absolute paths and dependency internals to API
 * consumers. Everything below is stripped (or redacted) before serialisation:
 *
 *  - keys that conventionally hold stack frames or nested exceptions
 *  - `Error` instances, functions, symbols and other non-serialisable values
 *  - strings that look like V8 stack frames or `file.ts:line:col` locations
 */
const REDACTED = "[REDACTED]";
const MAX_DETAIL_DEPTH = 4;

const UNSAFE_DETAIL_KEYS = new Set([
  "stack",
  "stacktrace",
  "trace",
  "originalerror",
  "originalexception",
  "cause",
  "err",
  "rawerror",
]);

const STACK_FRAME_PATTERN =
  /(?:\n\s+at\s)|(?:\bnode:internal\/)|(?:\b[A-Za-z]:\\[^:\n]+:\d+:\d+)|(?:\/[^\s:]+\.(?:ts|tsx|js|mjs|cjs):\d+:\d+)/;

function sanitizeDetailValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return undefined;

  const type = typeof value;
  if (type === "string") {
    return STACK_FRAME_PATTERN.test(value as string) ? REDACTED : value;
  }
  if (type === "number" || type === "boolean") return value;
  // JSON.stringify throws on BigInt; surface it as a string instead.
  if (type === "bigint") return (value as bigint).toString();
  if (type !== "object") return undefined; // functions, symbols

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeDetailValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (depth >= MAX_DETAIL_DEPTH) return REDACTED;

  return sanitizeDetailRecord(value as Record<string, unknown>, depth + 1);
}

function sanitizeDetailRecord(record: Record<string, unknown>, depth: number) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (UNSAFE_DETAIL_KEYS.has(key.toLowerCase())) continue;
    const sanitized = sanitizeDetailValue(value, depth);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return safe;
}

/**
 * Returns the client-safe subset of an error's `details` object. Exported so
 * the contract can be unit-tested directly.
 */
export function sanitizeErrorDetails(details: unknown): Record<string, unknown> {
  if (typeof details !== "object" || details === null || details instanceof Error) {
    return {};
  }
  if (Array.isArray(details)) return {};

  return sanitizeDetailRecord(details as Record<string, unknown>, 0);
}

function formatZodError(err: ZodError) {
  const flattened = err.flatten();
  return {
    code: "VALIDATION_ERROR",
    error: "validation_error",
    message: "Invalid request payload.",
    details: { fieldErrors: flattened.fieldErrors, formErrors: flattened.formErrors },
  };
}

/**
 * Issue #1460: stable unknown-route response contract.
 *
 * The body is intentionally static. The previous implementation echoed the
 * request line (`Route not found: ${req.method} ${req.originalUrl}`), which
 * (a) turned the response into an attacker-controlled reflection surface and
 * (b) leaked internal routing detail. Clients branch on the machine-readable
 * `error`/`code` fields, never on the message, so the message is fixed.
 *
 * Must stay byte-for-byte in step with docs/runbooks/api-evolution-runbook.md
 * ("Unknown-route contract").
 */
export function notFoundHandler(_req: Request, res: Response) {
  const requestId = res.locals.requestId ?? randomUUID();
  res.status(404).json({
    error: "not_found",
    code: "NOT_FOUND",
    message: "The requested resource does not exist.",
    requestId,
    details: {},
  });
}

/**
 * Maps an AppError to an HTTP status code.
 *
 * ASSUMPTION: this only knows about the ErrorCode/ErrorType members
 * already referenced in the original handler (NOT_FOUND, VALIDATION,
 * AUTH). If lib/errors.js defines more (CONFLICT, FORBIDDEN,
 * RATE_LIMITED, etc.), add them below — otherwise they'll silently fall
 * through to 500.
 *
 * Checks for an explicit `statusCode` on the error first. Longer term
 * it's more robust to have AppError carry its own status at the point
 * it's thrown (`throw new AppError(..., { statusCode: 409 })`) than to
 * have this handler reverse-engineer HTTP semantics from a business enum
 * — this function supports that without requiring it.
 */
function resolveAppErrorStatus(err: AppError): number {
  const explicitStatus = (err as AppError & { statusCode?: unknown }).statusCode;
  if (typeof explicitStatus === "number") {
    return explicitStatus;
  }

  if (err.code === ErrorCode.NOT_FOUND) return 404;
  if (err.code === ErrorCode.UNAUTHORIZED) return 401;
  if (err.type === ErrorType.VALIDATION) return 400;
  if (err.type === ErrorType.FORBIDDEN) return 403;
  // Auth *failures* (missing/invalid credentials) are 401, not 400. The
  // original mapping returned 400 here, which tells the client "your
  // request is malformed" instead of "you're not authenticated" — the
  // wrong signal for e.g. a frontend deciding whether to redirect to login.
  if (err.type === ErrorType.AUTH) return 401;
  if (err.type === ErrorType.CONFLICT) return 409;
  if (err.type === ErrorType.ACCOUNT_STATE) {
    return err.code === ErrorCode.ACCOUNT_NOT_FOUND ? 404 : 409;
  }
  return 500;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // If a response has already started streaming, sending another JSON
  // body throws "Cannot set headers after they are sent" and crashes the
  // process instead of gracefully handling the error. Hand off to
  // Express's default handler in that case.
  if (res.headersSent) {
    return next(err);
  }

  // Issue #1032: Every error response must carry a non-empty requestId.
  // When a parse error fires before the requestId middleware has run,
  // res.locals.requestId is undefined — generate one so the response is
  // still correlatable.
  const requestId = res.locals.requestId ?? randomUUID();
  res.locals.requestId = requestId;
  if (!res.getHeader("x-request-id")) {
    res.setHeader("x-request-id", requestId);
  }

  // Real instanceof check instead of duck-typing on err.name/err.issues —
  // ZodError is a real exported class, so this is both simpler and more
  // reliable than reflecting on shape.
  if (err instanceof ZodError) {
    return res.status(400).json({
      ...formatZodError(err),
      requestId,
    });
  }

  if (err instanceof AppError) {
    const status = resolveAppErrorStatus(err);
    // Sanitised once and reused for both the log line and the response, so a
    // detail value that is not JSON-safe (Error instance, BigInt, circular
    // reference) can never throw inside the handler and fall through to
    // Express's default HTML error page.
    const safeDetails = sanitizeErrorDetails(err.details);

    // Client-caused errors (bad input, bad/missing auth, not found) are
    // expected traffic, not bugs in our code — log them at `warn` so they
    // don't pollute error-rate alerts the way a genuine 500 should.
    const logLevel = status >= 500 ? "error" : "warn";
    logger[logLevel]("Application error", {
      requestId,
      path: req.originalUrl,
      method: req.method,
      type: err.type,
      code: err.code,
      message: err.message,
      details: safeDetails,
    });

    return res.status(status).json({
      error: err.code.toLowerCase(),
      code: err.code,
      // A 5xx AppError carries an internal message (an upstream client error,
      // a DB driver message, ...). Like the unhandled branch below, never
      // expose it in production; the real message is in the log line above.
      message: status >= 500 && isProduction() ? "Unexpected server error." : err.message,
      requestId,
      // Previously `err.details || { remediation: err.remediation }` —
      // if details existed but had no remediation baked in, remediation
      // was silently dropped. Merge both instead of picking one, and only
      // ever expose the sanitised subset (Issue #4).
      details: {
        ...safeDetails,
        ...(err.remediation ? { remediation: err.remediation } : {}),
      },
    });
  }

  // Express body-parser malformed-JSON (400) — thrown by express.json()
  // when the request body contains invalid JSON syntax.  Handle it before
  // the generic "unhandled error" path so clients always get a predictable
  // 400 error shape instead of a 500.  (Issue #1028)
  const parseError = err as { type?: string; status?: number; statusCode?: number; message?: string };
  if (parseError.type === "entity.parse.failed") {
    logger.warn("Malformed JSON payload", {
      requestId,
      path: req.originalUrl,
      method: req.method,
    });
    return res.status(400).json({
      error: "invalid_json",
      code: "INVALID_JSON",
      message: "Malformed JSON in request body.",
      requestId,
      details: {},
    });
  }

  // Express body-parser entity-too-large (413) — thrown by express.json()
  // when the request body exceeds its configured size limit (default 1mb).
  // Handle it before the generic "unhandled error" path so the correct 413
  // status is returned instead of an opaque 500. (Issue #840)
  const entityTooLarge = err as { type?: string; status?: number };
  if (entityTooLarge.type === "entity.too.large" && entityTooLarge.status === 413) {
    logger.warn("Request body too large", {
      requestId,
      path: req.originalUrl,
      method: req.method,
      contentLength: req.headers["content-length"],
    });
    return res.status(413).json({
      error: "payload_too_large",
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds the maximum allowed size (1 MB).",
      requestId,
      details: {},
    });
  }

  // RPC errors are expected, transient failure modes of talking to an
  // external dependency (Horizon/soroban-rpc), not bugs in this service.
  // Handling them here — before the generic "unhandled error" path below
  // — means they're logged at a level that reflects "dependency hiccup"
  // rather than "our code broke", and they're never reported to Sentry as
  // an unhandled exception.
  if (err instanceof RpcTimeoutError) {
    logger.warn("RPC timeout", { requestId, path: req.originalUrl, message: err.message });
    return res.status(504).json({
      error: "timeout_error",
      code: "RPC_TIMEOUT",
      message: err.message,
      requestId,
      details: {},
    });
  }

  if (err instanceof RpcError) {
    logger.warn("RPC error", {
      requestId,
      path: req.originalUrl,
      statusCode: err.statusCode,
      message: err.message,
    });
    return res.status(err.statusCode).json({
      error: "rpc_error",
      code: "RPC_ERROR",
      message: err.message,
      requestId,
      details: {},
    });
  }

  // Anything left is genuinely unexpected. A thrown value isn't
  // guaranteed to be an Error instance (`throw "oops"` is legal JS), so
  // normalize it before touching .stack/.message.
  const normalizedErr = err instanceof Error ? err : new Error(String(err));

  logger.error("Unhandled error", {
    requestId,
    path: req.originalUrl,
    method: req.method,
    err: normalizedErr.stack || normalizedErr.message,
  });

  if (process.env.SENTRY_DSN) {
    void import("@sentry/node").then((Sentry) => {
      Sentry.withScope((scope) => {
        scope.setTag("requestId", requestId);
        Sentry.captureException(normalizedErr);
      });
    });
  }

  res.status(500).json({
    error: "internal_error",
    code: "INTERNAL_ERROR",
    // Never leak internal error messages (stack traces, DB connection
    // errors, third-party error text) to the client in production — the
    // real message is already captured in the log line above. In dev, show
    // it for faster debugging.
    message: isProduction() ? "Unexpected server error." : normalizedErr.message,
    requestId,
    details: {},
  });
}
