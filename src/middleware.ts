import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { supabaseAdmin } from "./supabase.js";

declare global {
  namespace Express {
    interface Request { userId?: string; }
  }
}

export const resolveUser: RequestHandler = async (req, _res, next) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token) {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !data.user) throw new AppError("Invalid or expired access token.", 401);
      req.userId = data.user.id;
    } else if (config.defaultUserId) req.userId = config.defaultUserId;
    next();
  } catch (error) { next(error); }
};

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.userId) return next(new AppError("Authentication is required.", 401));
  next();
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
