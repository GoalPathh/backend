import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const rawEnv = {
  ...process.env,
  SUPABASE_URL:
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.PUBLIC_URL,
  SUPABASE_PUBLISHABLE_KEY:
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

const env = z.object({
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DEFAULT_USER_ID: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().uuid().optional(),
  ),
  LLM_PROVIDER_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/openai"),
  LLM_API_KEY: z.string().default("mock-key"),
  LLM_MODEL: z.string().default("gemini-3.1-flash-lite"),
  CLOUDINARY_CLOUD_NAME: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().optional(),
  ),
  CLOUDINARY_API_KEY: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().optional(),
  ),
  CLOUDINARY_API_SECRET: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().optional(),
  ),
  CLOUDINARY_UPLOAD_FOLDER: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().optional(),
  ),
  // "raw"   = custom fetch + SSE parser (best for LMStudio / Ollama / TokenRouter / Gemini proxy
  //           where Vercel SDK's streaming parser has historically mis-handled partial chunks)
  // "vercel" = ai SDK + @ai-sdk/openai (best for hosted OpenAI / together.ai / groq / vLLM
  //           that emit strict OpenAI-compatible JSON or SSE)
  LLM_DRIVER: z.enum(["raw", "vercel"]).default("raw"),
}).parse(rawEnv);

export const config = {
  port: env.PORT,
  frontendUrl: env.FRONTEND_URL,
  supabaseUrl: env.SUPABASE_URL,
  supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY,
  supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  defaultUserId: env.DEFAULT_USER_ID || undefined,
  llmProviderUrl: env.LLM_PROVIDER_URL,
  llmApiKey: env.LLM_API_KEY,
  llmModel: env.LLM_MODEL,
  cloudinaryCloudName: env.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: env.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: env.CLOUDINARY_API_SECRET,
  cloudinaryUploadFolder: env.CLOUDINARY_UPLOAD_FOLDER || "goalpath/avatars",
  llmDriver: env.LLM_DRIVER,
};
