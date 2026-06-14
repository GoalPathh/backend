import "dotenv/config";
import { z } from "zod";

const env = z.object({
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DEFAULT_USER_ID: z.string().uuid().optional(),
  LLM_PROVIDER_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().default("mock-key"),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  // "raw"   = custom fetch + SSE parser (best for LMStudio / Ollama / TokenRouter / Gemini proxy
  //           where Vercel SDK's streaming parser has historically mis-handled partial chunks)
  // "vercel" = ai SDK + @ai-sdk/openai (best for hosted OpenAI / together.ai / groq / vLLM
  //           that emit strict OpenAI-compatible JSON or SSE)
  LLM_DRIVER: z.enum(["raw", "vercel"]).default("raw"),
}).parse(process.env);

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
  llmDriver: env.LLM_DRIVER,
};
