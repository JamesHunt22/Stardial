import { NextFunction, Request, Response, Router } from "express";
import { AppError, ErrorCode, ErrorType } from "../lib/errors.js";
import { validateRequest } from "../middleware/validate.js";
import {
  webhookDeliveryIdSchema,
  webhookHeadersSchema,
  webhookProviderParamsSchema,
  type WebhookHeaders,
} from "../schemas/api-input.schemas.js";
import {
  extractWebhookDeliveryId,
  getWebhookSigningSecret,
  normalizeProvider,
  processWebhookDelivery,
  verifyWebhookSignature,
} from "../services/webhooks.service.js";

export const webhooksRouter = Router();

function unauthorized(message: string): AppError {
  const error = new AppError(ErrorType.AUTH, ErrorCode.UNAUTHORIZED, message);
  (error as AppError & { statusCode?: number }).statusCode = 401;
  return error;
}

webhooksRouter.post(
  "/:provider",
  validateRequest({ params: webhookProviderParamsSchema, headers: webhookHeadersSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Provider and signature headers come from the shared validated layer.
      const provider = normalizeProvider(req.params.provider as string);
      const headers = (res.locals.validatedHeaders ?? {}) as WebhookHeaders;

      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        throw unauthorized("Webhook signature could not be verified.");
      }

      const secret = getWebhookSigningSecret(provider);
      if (!secret) {
        throw unauthorized("Webhook signing is not configured.");
      }

      const signature =
        headers["x-webhook-signature"] ??
        headers["x-signature"] ??
        headers["x-hub-signature-256"];
      if (!verifyWebhookSignature(rawBody, signature, secret)) {
        throw unauthorized("Webhook signature is invalid.");
      }

      const deliveryId =
        headers["x-webhook-id"] ??
        headers["x-delivery-id"] ??
        headers["x-event-id"] ??
        extractWebhookDeliveryId(req, req.body);
      const validatedDeliveryId = webhookDeliveryIdSchema.parse({ deliveryId }).deliveryId;

      const result = await processWebhookDelivery(provider, validatedDeliveryId, req.body, rawBody);
      return res.status(200).json({
        received: true,
        duplicate: result.outcome === "duplicate",
      });
    } catch (error) {
      return next(error);
    }
  }
);
