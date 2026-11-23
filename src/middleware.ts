import type { ErrorRequestHandler, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { ZodError } from "zod";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { SubscriptionService } from "./services/subscriptionService.js";
import type { SubscriptionResponse } from "./dto/subscription.js";
import { prisma } from "./db.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: string;
      subscription?: SubscriptionResponse;
    }
  }
}

const subscriptionService = new SubscriptionService();

export const resolveUser: RequestHandler = async (req, _res, next) => {
  try {
    const token =
      req.cookies?.goalpath_access_token ||
      req.headers.authorization?.replace(/^Bearer\s+/i, "");

    if (token) {
      try {
        const decoded = jwt.verify(token, config.jwtSecret) as { sub: string };
        if (decoded?.sub) {
          req.userId = decoded.sub;
          // Ambil role dari DB — tidak mempercayai data dari client/frontend
          const user = await prisma.user.findUnique({
            where: { id: decoded.sub },
            select: { role: true },
          });
          if (user) {
            req.userRole = user.role;
          }
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

/**
 * requireRole — hanya izinkan user dengan role tertentu.
 * Contoh: requireRole("ADMIN")
 */
export const requireRole = (role: string): RequestHandler => (req, _res, next) => {
  if (!req.userId) return next(new AppError("Authentication is required.", 401));
  if (req.userRole !== role) return next(new AppError("Access forbidden. Insufficient permissions.", 403));
  next();
};

/**
 * requireOwnership — middleware untuk memverifikasi kepemilikan resource sebelum request diproses.
 * Memastikan req.userId adalah pemilik sah dari resource yang diminta.
 * Sesuai kebijakan keamanan, jika resource tidak ditemukan atau dimiliki pengguna lain,
 * sistem mengembalikan 404 Not Found untuk mencegah enumerasi ID (information disclosure).
 */
export const requireOwnership = (
  model: "goal" | "habit" | "coachSession",
  paramKey = "id",
): RequestHandler => async (req, _res, next) => {
  if (!req.userId) return next(new AppError("Authentication is required.", 401));
  const rawId = req.params[paramKey];
  const resourceId = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!resourceId) return next(new AppError("Resource identifier is missing.", 400));

  try {
    let ownerId: string | null = null;
    if (model === "goal") {
      const item = await prisma.goal.findUnique({
        where: { id: resourceId },
        select: { user_id: true },
      });
      ownerId = item?.user_id ?? null;
    } else if (model === "habit") {
      const item = await prisma.habit.findUnique({
        where: { id: resourceId },
        select: { user_id: true },
      });
      ownerId = item?.user_id ?? null;
    } else if (model === "coachSession") {
      const item = await prisma.coachSession.findUnique({
        where: { id: resourceId },
        select: { user_id: true },
      });
      ownerId = item?.user_id ?? null;
    }

    if (!ownerId || ownerId !== req.userId) {
      return next(new AppError(`${model.charAt(0).toUpperCase() + model.slice(1)} not found.`, 404));
    }

    next();
  } catch (error) {
    next(error);
  }
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
