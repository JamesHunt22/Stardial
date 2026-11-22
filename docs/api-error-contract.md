# API error responses

Every JSON response with a 4xx or 5xx status includes these fields:

```json
{
  "error": "validation_error",
  "code": "VALIDATION_ERROR",
  "message": "Invalid request payload.",
  "requestId": "request-123",
  "details": {}
}
```

- `error` is a lowercase machine-readable identifier; `code` is an uppercase code.
  Existing domain-specific identifiers are retained. Some errors use a shared code
  (for example, SSE capacity errors use `RESOURCE_LIMIT_EXCEEDED`).
- `message` describes the failure. Clients should branch on codes, not message text.
- `requestId` matches the `X-Request-ID` response header. The server generates an ID
  when request-correlation middleware has not run, including JSON parsing failures.
- `details` is always an object, empty when there is no additional context.
  Zod request validation uses `details.fieldErrors` and `details.formErrors`, whether
  the schema is parsed in a route or by `validateRequest`. Internal exception and
  stack metadata are removed before sending details. Unknown fields rejected by
  the shared request-validation layer use a fixed message, so hostile field
  names are never reflected; see [API Surface Contracts](api-surface-contracts.md#request-input-validation-contract-issue-5).

Route-specific fields remain available, including health component diagnostics,
permission decisions, and retry timing. Successful JSON bodies, streaming SSE
messages, and plain-text metrics keep their existing contracts.

| Status | Meaning |
| --- | --- |
| 400 | Invalid request, malformed JSON, or invalid contract input |
| 401 | Missing, invalid, or revoked credentials |
| 403 | Authenticated caller lacks permission |
| 404 | Requested resource or route does not exist |
| 409 | Conflict with resource state, including existing or locked projects |
| 410 | Resource is no longer available, such as a cancelled invitation |
| 413 | Request body exceeds the configured limit |
| 429 | Request or connection capacity limit exceeded |
| 500 | Unexpected server failure |
| 502 | Upstream RPC failure |
| 503 | Service unavailable or writes temporarily disabled |
| 504 | Request or RPC timeout |

Contributors should use `sendErrorResponse` from `backend/src/lib/api-error.ts`
for direct failures, or forward exceptions to `errorHandler`. Typed domain errors
may provide an explicit 4xx/5xx `statusCode`; otherwise the central handler maps
known error types and codes. Unknown internal failures remain 500. Existing
production message sanitization in the central handler is preserved.

The required envelope fields are also defined by `ApiError` in the generated
[OpenAPI specification](openapi.yaml).
