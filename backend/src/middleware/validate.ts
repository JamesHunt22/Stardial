import type { RequestHandler } from "express";
import { ZodError, type ZodTypeAny } from "zod";

interface ValidationSchemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  /** Selected request headers; unknown standard headers are intentionally ignored. */
  headers?: ZodTypeAny;
}

/**
 * Zod's default `unrecognized_keys` message repeats the offending key name.
 * Replace it with a fixed message so hostile field names can never be
 * reflected in a client-facing 400 response.
 */
function clientSafeValidationError(error: ZodError): ZodError {
  const issues = error.issues.map((issue) =>
    issue.code === "unrecognized_keys" ? { ...issue, message: "Unexpected field." } : issue
  );
  return new ZodError(issues);
}

/**
 * Shared request-validation layer. Parsed (trimmed, normalized) body/params
 * values replace the raw request values, while parsed query and selected header
 * values are exposed as `res.locals.validatedQuery` / `res.locals.validatedHeaders`
 * because Node defines `req.query` as a getter-only accessor. Failures are
 * forwarded to the central error handler, which returns the standard 400
 * validation envelope with `details.fieldErrors` / `details.formErrors`.
 */
export function validateRequest(schemas: ValidationSchemas): RequestHandler {
  return (req, res, next) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as typeof req.params;
      }
      if (schemas.query) {
        // Node's `req.query` is a getter-only accessor in newer runtimes, so
        // parsed query values are exposed on res.locals instead of assigned.
        const parsedQuery = schemas.query.safeParse(req.query);
        if (!parsedQuery.success) throw clientSafeValidationError(parsedQuery.error);
        res.locals.validatedQuery = parsedQuery.data;
      }
      if (schemas.headers) {
        const parsedHeaders = schemas.headers.safeParse(req.headers);
        if (!parsedHeaders.success) throw clientSafeValidationError(parsedHeaders.error);
        res.locals.validatedHeaders = parsedHeaders.data;
      }
      next();
    } catch (error) {
      next(error instanceof ZodError ? clientSafeValidationError(error) : error);
    }
  };
}
