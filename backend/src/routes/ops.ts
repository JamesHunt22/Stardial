import { sendErrorResponse } from "../lib/api-error.js";
import { Router, type NextFunction } from "express";
import { logger } from "../services/logger.js";
import { getEnvDiagnostics } from "../config/env.js";
import { getDataSource } from "../services/database.js";
import { getCacheStats } from "../services/stellar.js";
import { backfillEvents, getLedgerLag, getServiceHealth } from "../services/EventListenerService.js";
import { withResponseValidation } from "../middleware/validateResponse.js";
import {
  OpsStatusResponseSchema,
  OpsBackfillRequestSchema,
  OpsBackfillResponseSchema,
  MainnetReadinessResponseSchema,
} from "../schemas/admin.schemas.js";
import { getIdempotencyConflictsTotal, getIdempotencyReplaysTotal } from "../services/metrics.js";

export const opsRouter = Router();

interface ReadinessComponent {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface MainnetReadinessResponse {
  status: "ready" | "not_ready";
  requestId?: string;
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
  components: {
    env: ReadinessComponent;
    db: ReadinessComponent;
    cache: ReadinessComponent;
    deploy: ReadinessComponent & {
      productionSecrets?: {
        mainnetContractId: boolean;
        renderBackendDeployHookUrl: boolean;
      };
      contractIdMatch?: boolean;
      databasePoolMax?: number;
      readCacheTtlMs?: number;
      readCacheMaxEntries?: number;
    };
  };
}

opsRouter.post(
  "/backfill",      withResponseValidation(OpsBackfillResponseSchema, async (req, res, next: NextFunction) => {
    const parsed = OpsBackfillRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendErrorResponse(res, 400, {
        success: false,
        error: "invalid_backfill_request",
        message: "A positive integer `fromLedger` is required (the last known good ledger).",
      });
      return;
    }

    try {
      const result = await backfillEvents(parsed.data.fromLedger);

      res.json({
        success: true,
        message: result.caughtUp
          ? `Backfill caught up: ${result.recordsIndexed} payout record(s) upserted from ledger ${result.fromLedger}.`
          : `Backfill stopped at the page budget before catching up. Re-run from ledger ${result.lastLedgerScanned ?? result.fromLedger}.`,
        ...result,
      });
    } catch (error) {
      // Issue #4: hand the raw exception to the central handler. Echoing
      // `error.message` here leaked Postgres/TypeORM internals (table names,
      // SQL fragments, file paths) straight to the caller.
      return next(error);
    }
  })
);

opsRouter.get(
  "/status",
  withResponseValidation(OpsStatusResponseSchema, (_req, res) => {
    res.json({
      eventListener: { ...getServiceHealth(), ledgerLag: getLedgerLag() },
      database: { connected: getDataSource().isInitialized },
      idempotency: {
        conflictsTotal: getIdempotencyConflictsTotal(),
        replaysTotal: getIdempotencyReplaysTotal(),
      },
    });
  })
);

opsRouter.get(
  "/mainnet-readiness",
  withResponseValidation(MainnetReadinessResponseSchema, async (_req, res) => {
  const requestId = res.locals.requestId;
  const envDiagnostics = getEnvDiagnostics();

  const envComponent: ReadinessComponent = envDiagnostics.ok
    ? { ok: true }
    : { ok: false, message: "invalid_environment", details: { issues: envDiagnostics.issues } };

  const cacheStats = getCacheStats();
  const cacheComponent: ReadinessComponent = {
    ok: true,
    message: "cache_available",
    details: cacheStats
  };

  const productionSecrets = {
    mainnetContractId: Boolean(process.env.MAINNET_CONTRACT_ID?.trim()),
    renderBackendDeployHookUrl: Boolean(process.env.RENDER_BACKEND_DEPLOY_HOOK_URL?.trim())
  };

  const isProduction = process.env.NODE_ENV === "production";
  const productionReady = !isProduction || Object.values(productionSecrets).every(Boolean);

  const deployComponent: MainnetReadinessResponse["components"]["deploy"] = {
    ok: productionReady,
    message: "production_config_audit",
    productionSecrets,
    contractIdMatch: process.env.MAINNET_CONTRACT_ID && process.env.CONTRACT_ID
      ? process.env.MAINNET_CONTRACT_ID === process.env.CONTRACT_ID
      : undefined,
    databasePoolMax: process.env.DATABASE_POOL_MAX ? Number(process.env.DATABASE_POOL_MAX) : undefined,
    readCacheTtlMs: process.env.READ_CACHE_TTL_MS ? Number(process.env.READ_CACHE_TTL_MS) : undefined,
    readCacheMaxEntries: process.env.READ_CACHE_MAX_ENTRIES ? Number(process.env.READ_CACHE_MAX_ENTRIES) : undefined
  };

  let dbComponent: ReadinessComponent = { ok: false, message: "unknown" };

  try {
    const ds = getDataSource();
    const queryResult = await ds.query("SELECT 1 AS one");
    dbComponent = {
      ok: true,
      message: "database_query_ok",
      details: { rowCount: Array.isArray(queryResult) ? queryResult.length : undefined }
    };
  } catch (error) {
    // Issue #4: the driver error stays in the logs. This endpoint is public
    // readiness surface, so the response only carries the stable reason code.
    logger.error("Mainnet readiness database probe failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error)
    });
    dbComponent = {
      ok: false,
      message: "database_unavailable",
      details: {}
    };
  }

  const ready = envDiagnostics.ok && dbComponent.ok && productionReady;

  const response: MainnetReadinessResponse = {
    status: ready ? "ready" : "not_ready",
    requestId,
    components: {
      env: envComponent,
      db: dbComponent,
      cache: cacheComponent,
      deploy: deployComponent
    }
  };

  if (!ready) {
    const missing = [] as string[];
    if (!envDiagnostics.ok) missing.push("env");
    if (!dbComponent.ok) missing.push("db");
    if (!productionReady) missing.push("production_secrets");

    sendErrorResponse(res, 503, {
      ...response,
      error: "mainnet_readiness_failed",
      message: "Mainnet readiness validation failed. Review the component details.",
      details: { missing }
    });
    return;
  }

  res.json(response);
  })
);
