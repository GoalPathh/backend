import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { supabaseAuth } from "./supabase.js";
import { SubscriptionService } from "./services/subscriptionService.js";
import type { SubscriptionResponse } from "./dto/subscription.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      subscription?: SubscriptionResponse;
    }
  }
}

const subscriptionService = new SubscriptionService();

export const resolveUser: RequestHandler = async (req, _res, next) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token) {
      const { data, error } = await supabaseAuth.auth.getUser(token);
      if (error || !data.user) throw new AppError("Invalid or expired access token.", 401);
      req.userId = data.user.id;
    }
    // SECURE: Removed config.defaultUserId bypass
    next();
  } catch (error) { next(error); }
};

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.userId) return next(new AppError("Authentication is required.", 401));
  next();
};

/** Best-effort attach subscription snapshot for the current user. */
export const attachSubscription: RequestHandler = async (req, _res, next) => {
  if (req.userId && !req.subscription) {
    try {
      req.subscription = await subscriptionService.getMySubscription(req.userId);
    } catch (error) {
      // Don't block the request — just log.
      console.warn("[middleware] attachSubscription failed:", (error as Error).message);
    }
  }
  next();
};

/** Reject request with 402 unless the user has an active premium subscription. */
export const requirePremium: RequestHandler = async (req, _res, next) => {
  if (!req.userId) return next(new AppError("Authentication is required.", 401));
  try {
    const sub = await subscriptionService.getMySubscription(req.userId);
    req.subscription = sub;
    if (sub.tier !== "premium") {
      return next(new AppError(
        "Fitur ini khusus member Premium. Silakan upgrade akun Anda untuk membuka akses.",
        402,
      ));
    }
  } catch (error) { next(error); }
};
export const notFound: RequestHandler = (req, _res, next) => next(new AppError(`Route ${req.method} ${req.path} was not found.`, 404));
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: { message: "Invalid request.", details: error.flatten() } });
    return;
  }
  const statusCode = error instanceof AppError ? error.statusCode : 500;
  res.status(statusCode).json({ error: { message: error instanceof Error ? error.message : "Internal server error.", details: error instanceof AppError ? error.details : undefined } });
};
