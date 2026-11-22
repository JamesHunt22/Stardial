import type { Response } from "express";
import { randomUUID } from "node:crypto";

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

interface ErrorPayload {
  error?: string;
  code?: string;
  message?: string;
  details?: unknown;
  [key: string]: unknown;
}

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "Invalid request payload.",
  401: "Authentication is required.",
  403: "You do not have permission to perform this action.",
  404: "The requested resource does not exist.",
  409: "The request conflicts with the current resource state.",
  410: "The requested resource is no longer available.",
  413: "Request body exceeds the maximum allowed size (1 MB).",
  429: "Too many requests. Please try again later.",
  500: "Unexpected server error.",
  502: "An upstream service could not complete the request.",
  503: "Service temporarily unavailable.",
  504: "Request timed out.",
};

/** Shared JSON error envelope. Route-specific extension fields remain available. */
export function sendErrorResponse(res: Response, status: number, payload: ErrorPayload) {
  const requestId = res.locals.requestId ?? randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  const error = (payload.error ?? payload.code ?? "internal_error").toLowerCase();
  return res.status(status).json({
    ...payload,
    error,
    code: (payload.code ?? error).toUpperCase(),
    message: payload.message || DEFAULT_MESSAGES[status] || "The request could not be completed.",
    requestId,
    details: sanitizeErrorDetails(payload.details),
  });
}
