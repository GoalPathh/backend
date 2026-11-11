import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const env = z.object({
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().default("goalpath_jwt_super_secret_key_change_in_prod"),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),
  DEFAULT_USER_ID: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().uuid().optional(),
  ),
  LLM_PROVIDER_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/openai"),
  LLM_API_KEY: z.string().default("mock-key"),
  LLM_MODEL: z.string().default("gemini-3.1-flash-lite"),
  CLOUDINARY_CLOUD_NAME: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  CLOUDINARY_API_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  CLOUDINARY_API_SECRET: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  CLOUDINARY_UPLOAD_FOLDER: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  LLM_DRIVER: z.enum(["raw", "vercel"]).default("raw"),
  MIDTRANS_SERVER_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  MIDTRANS_CLIENT_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  MIDTRANS_IS_PRODUCTION: z.preprocess((value) => value === "true" || value === true, z.boolean().default(false)),
  PREMIUM_PRICE_IDR: z.coerce.number().int().min(1).default(150000),
  PREMIUM_PERIOD_DAYS: z.coerce.number().int().min(1).default(30),
}).parse(process.env);

export const config = {
  port: env.PORT,
  frontendUrl: env.FRONTEND_URL,
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  jwtRefreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  defaultUserId: env.DEFAULT_USER_ID || undefined,
  llmProviderUrl: env.LLM_PROVIDER_URL,
  llmApiKey: env.LLM_API_KEY,
  llmModel: env.LLM_MODEL,
  cloudinaryCloudName: env.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: env.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: env.CLOUDINARY_API_SECRET,
  cloudinaryUploadFolder: env.CLOUDINARY_UPLOAD_FOLDER || "goalpath/avatars",
  llmDriver: env.LLM_DRIVER,
  midtransServerKey: env.MIDTRANS_SERVER_KEY,
  midtransClientKey: env.MIDTRANS_CLIENT_KEY,
  midtransIsProduction: env.MIDTRANS_IS_PRODUCTION,
  premiumPriceIdr: env.PREMIUM_PRICE_IDR,
  premiumPeriodDays: env.PREMIUM_PERIOD_DAYS,
};
