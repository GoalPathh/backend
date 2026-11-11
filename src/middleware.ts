import type { ErrorRequestHandler, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { ZodError } from "zod";
import { config } from "./config.js";
import { AppError } from "./errors.js";
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

export const resolveUser: RequestHandler = (req, _res, next) => {
  try {
    const token =
      req.cookies?.goalpath_access_token ||
      req.headers.authorization?.replace(/^Bearer\s+/i, "");

    if (token) {
      try {
        const decoded = jwt.verify(token, config.jwtSecret) as { sub: string };
        if (decoded?.sub) {
          req.userId = decoded.sub;
        }
      } catch {
        // Token invalid atau expired — abaikan di sini agar route publik bisa handle refresh
      }
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.userId) return next(new AppError("Authentication is required.", 401));
  next();
};

export const attachSubscription: RequestHandler = async (req, _res, next) => {
  if (req.userId && !req.subscription) {
    try {
      req.subscription = await subscriptionService.getMySubscription(req.userId);
    } catch (error) {
      console.warn("[middleware] attachSubscription failed:", (error as Error).message);
    }
  }
  next();
};

export const requirePremium: RequestHandler = async (req, _res, next) => {
  if (!req.userId) return next(new AppError("Authentication is required.", 401));
  try {
    const sub = await subscriptionService.getMySubscription(req.userId);
    req.subscription = sub;
    if (sub.tier !== "premium") {
      return next(
        new AppError(
          "Fitur ini khusus member Premium. Silakan upgrade akun Anda untuk membuka akses.",
          402,
        ),
      );
    }
  } catch (error) {
    next(error);
  }
};

export const notFound: RequestHandler = (req, _res, next) =>
  next(new AppError(`Route ${req.method} ${req.path} was not found.`, 404));

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: { message: "Invalid request.", details: error.flatten() } });
    return;
  }
  const statusCode = error instanceof AppError ? error.statusCode : 500;
  res.status(statusCode).json({
    error: {
      message: error instanceof Error ? error.message : "Internal server error.",
      details: error instanceof AppError ? error.details : undefined,
    },
  });
};
