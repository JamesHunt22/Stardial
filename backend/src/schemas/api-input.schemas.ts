/**
 * Shared request-input schemas (Issue #5).
 *
 * Route schemas live here so validation is a single, reusable layer rather
 * than ad hoc checks in each handler. Everything in `body`, `params` and
 * `query` is strict: unknown fields are rejected. Header schemas are
 * intentionally not strict because every HTTP request carries standard
 * headers; only the headers a route consumes are picked out and validated.
 */
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { isValidAmountString } from "../lib/decimal-amounts.js";
import { decodeTransactionCursor } from "../lib/keyset-cursor.js";
import { transactionRecipientQuerySchema } from "./transactions.schemas.js";

/** Detect control characters without a regex literal (keeps ESLint's no-control-regex rule quiet). */
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

/** Trimmed, non-empty text with a hard length ceiling and no control characters. */
export const safeTextSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !hasControlCharacters(value), {
      message: "must not contain control characters",
    });

/** Classic Stellar account ID (G…), verified with the SDK StrKey checksum. */
export const stellarAccountIdSchema = z
  .string()
  .trim()
  .refine((value) => StrKey.isValidEd25519PublicKey(value), {
    message: "Must be a valid Stellar account ID (G…)",
  });

/** Stellar transaction hash: 64 hexadecimal characters. */
export const transactionHashSchema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{64}$/, { message: "Must be a 64-character hexadecimal transaction hash" });

/**
 * Opaque transaction key used by the SSE event bus. Existing clients use short
 * identifiers here, so the schema constrains it to a safe character set
 * instead of requiring a Stellar transaction hash.
 */
export const eventTransactionKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, {
    message: "Must be a 1-128 character transaction key (letters, digits, ., _, :, -)",
  });

/** Positive bounded decimal amount: at most 7 fractional digits, <= i128 max. */
export const positiveAmountSchema = z
  .string()
  .trim()
  .refine((value) => isValidAmountString(value), {
    message: "Must be a canonical decimal amount with at most 7 decimal places",
  })
  .refine((value) => /[1-9]/.test(value), { message: "Amount must be greater than zero" });

/** Stellar asset code: 1-12 alphanumeric characters (ISO 4217-style codes included). */
export const assetCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,12}$/, { message: "Must be a 1-12 character alphanumeric asset code" });

/** Stellar text memo: max 28 UTF-8 bytes, no control characters. */
export const textMemoSchema = z
  .string()
  .trim()
  .refine((value) => Buffer.byteLength(value, "utf8") <= 28, {
    message: "Memo must be at most 28 UTF-8 bytes",
  })
  .refine((value) => !hasControlCharacters(value), {
    message: "Memo must not contain control characters",
  });

// ── Per-endpoint schemas ──────────────────────────────────────────────────────

/** Routes with no documented query parameters reject all query input. */
export const noQuerySchema = z.object({}).strict();

export const transactionHashParamsSchema = z
  .object({ txHash: transactionHashSchema })
  .strict();

export const eventTransactionParamsSchema = z
  .object({ txHash: eventTransactionKeySchema })
  .strict();

export const eventStreamQuerySchema = z
  .object({ txHash: eventTransactionKeySchema })
  .strict();

export const walletAddressParamsSchema = z
  .object({ walletAddress: stellarAccountIdSchema })
  .strict();

/** Cursor format is checked here so every 400 uses the shared Zod fieldErrors envelope. */
export const recipientQuerySchema = transactionRecipientQuerySchema.strict().refine(
  ({ cursor }) => {
    if (!cursor) return true;
    try {
      decodeTransactionCursor(cursor);
      return true;
    } catch {
      return false;
    }
  },
  { path: ["cursor"], message: "Must be a valid opaque page cursor" }
);

/** Webhook provider path segment: lowercase identifier, no whitespace or path separators. */
export const webhookProviderParamsSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
        message: "Must be a 1-64 character webhook provider identifier",
      }),
  })
  .strict();

const signatureHeaderSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9=,._+/: -]+$/, {
    message: "Signature header must contain only signature characters",
  });

const deliveryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:$-]+$/, {
    message: "Delivery ID must contain only letters, digits, ., _, :, $ or -",
  });

const deliveryIdHeaderSchema = deliveryIdSchema;

/** Only headers consumed by the webhook route are picked; standard headers pass through. */
export const webhookHeadersSchema = z
  .object({
    "x-webhook-signature": signatureHeaderSchema.optional(),
    "x-signature": signatureHeaderSchema.optional(),
    "x-hub-signature-256": signatureHeaderSchema.optional(),
    "x-webhook-id": deliveryIdHeaderSchema.optional(),
    "x-delivery-id": deliveryIdHeaderSchema.optional(),
    "x-event-id": deliveryIdHeaderSchema.optional(),
  })
  .strip();

export type WebhookHeaders = z.infer<typeof webhookHeadersSchema>;

/** Delivery IDs can also arrive in the payload; validate before claiming in the DB. */
export const webhookDeliveryIdSchema = z
  .object({ deliveryId: deliveryIdSchema })
  .strict();
