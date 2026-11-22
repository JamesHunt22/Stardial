/**
 * In-memory idempotency key store (Issue #888).
 *
 * Mirrors the in-memory, per-instance strategy already used by
 * `middleware/rate-limit.ts` rather than adding a database table: keys are
 * short-lived (default 24h) and only need to survive for the retry window of
 * a single client, so persisting them to Postgres would add migration and
 * query overhead without a corresponding reliability benefit.
 *
 * Semantics:
 * - A (scope, key) pair is claimed atomically via `tryAcquire`, which returns
 *   the existing record if one is present instead of overwriting it. This is
 *   what prevents two concurrent retries from both executing the mutation.
 * - Callers must check `requestHash` on a hit: reusing an idempotency key with
 *   a different payload is a client error and must be rejected, not replayed.
 * - Records in `in_progress` state are NOT replayed; callers should return a
 *   409 so the client retries later rather than double-executing.
 */

export interface IdempotencyRecord {
  requestHash: string;
  status: "in_progress" | "completed";
  statusCode?: number;
  body?: unknown;
}

interface StoredEntry extends IdempotencyRecord {
  expiresAt: number;
}

export type AcquireResult =
  | { acquired: true }
  | { acquired: false; existing: IdempotencyRecord };

const DEFAULT_TTL_MS = Number(process.env.IDEMPOTENCY_KEY_TTL_MS ?? 24 * 60 * 60 * 1000);

export class IdempotencyStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  private buildKey(scope: string, key: string): string {
    return `${scope}::${key}`;
  }

  private getLive(storeKey: string): StoredEntry | undefined {
    const entry = this.entries.get(storeKey);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(storeKey);
      return undefined;
    }
    return entry;
  }

  get(scope: string, key: string): IdempotencyRecord | undefined {
    return this.getLive(this.buildKey(scope, key));
  }

  /**
   * Atomically claims the key for this request. Because Node.js executes
   * synchronous code without interleaving, the check-and-set here is safe
   * against concurrent requests within a single process.
   */
  tryAcquire(scope: string, key: string, requestHash: string): AcquireResult {
    const storeKey = this.buildKey(scope, key);
    const existing = this.getLive(storeKey);
    if (existing) {
      return { acquired: false, existing };
    }
    this.entries.set(storeKey, {
      requestHash,
      status: "in_progress",
      expiresAt: this.now() + this.ttlMs
    });
    return { acquired: true };
  }

  markInProgress(scope: string, key: string, requestHash: string): void {
    this.entries.set(this.buildKey(scope, key), {
      requestHash,
      status: "in_progress",
      expiresAt: this.now() + this.ttlMs
    });
  }

  complete(scope: string, key: string, requestHash: string, statusCode: number, body: unknown): void {
    this.entries.set(this.buildKey(scope, key), {
      requestHash,
      status: "completed",
      statusCode,
      body,
      expiresAt: this.now() + this.ttlMs
    });
  }

  remove(scope: string, key: string): void {
    this.entries.delete(this.buildKey(scope, key));
  }

  clear(): void {
    this.entries.clear();
  }
}

export const idempotencyStore = new IdempotencyStore();
