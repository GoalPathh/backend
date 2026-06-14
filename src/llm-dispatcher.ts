/**
 * Unified LLM client dispatcher.
 *
 * Two implementations available:
 *  - "raw"   = custom Node fetch + SSE parser (llm-client.ts). Best for
 *              LMStudio / Ollama / TokenRouter / Gemini proxies where the upstream emits
 *              partial / non-standard chunks that the Vercel parser sometimes mishandles.
 *  - "vercel" = ai SDK + @ai-sdk/openai (this file). Best for hosted OpenAI / together.ai
 *              / groq / vLLM proxies that emit strict OpenAI-compatible JSON or SSE.
 *
 * Switch via `LLM_DRIVER` env var (default "raw").
 */

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { config } from "./config.js";

// Lazy-initialized so Vercel SDK isn't required to start the server with LLM_DRIVER=raw.
let openaiProvider: ReturnType<typeof createOpenAI> | null = null;
function getProvider() {
  if (!openaiProvider) {
    openaiProvider = createOpenAI({
      baseURL: config.llmProviderUrl,
      apiKey: config.llmApiKey,
    });
  }
  return openaiProvider;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Plain chat completion via Vercel AI SDK. No tool-calling support here (use raw
 * dispatcher if you need tools) — vercel-driver is positioned for hosted environments
 * where uptime > tool richness.
 */
export async function agentChatVercel(
  systemPrompt: string,
  messages: LLMMessage[],
): Promise<string> {
  const provider = getProvider() as unknown as (id: string) => any;
  const result = await generateText({
    model: provider(config.llmModel) as any,
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    })),
  });
  return (result.text ?? "").trim();
}

/**
 * Plain-JSON milestone suggestion via Vercel AI SDK (no tools, just text-with-json).
 */
export async function agentSuggestMilestonesVercel(opts: {
  goalTitle: string;
  category?: string;
  duration?: string;
  habits?: { title: string; difficulty?: string }[];
}): Promise<Array<{ title: string; target_date?: string }>> {
  const systemPrompt = `You are a GoalPath milestone planner. Propose 3 to 5 progressive milestones aligned to a user goal.
Output STRICT JSON ONLY. Schema: {"milestones":[{"title":"<short>", "target_date":"YYYY-MM-DD"}]}
Same language as goal title.`;
  const userPrompt =
    `Goal: ${opts.goalTitle}\nCategory: ${opts.category ?? "other"}\nDuration: ${opts.duration ?? "3months"}\n` +
    `Habits:\n${(opts.habits ?? []).map((h) => `- ${h.title}`).join("\n") || "(none)"}`;

  const provider = getProvider() as unknown as (id: string) => any;
  try {
    const result = await generateText({
      model: provider(config.llmModel) as any,
      system: systemPrompt,
      prompt: userPrompt,
    });
    const text = result.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]);
      if (obj?.milestones && Array.isArray(obj.milestones)) {
        return obj.milestones
          .filter((m: any) => m?.title)
          .slice(0, 5)
          .map((m: any) => ({ title: String(m.title), target_date: m.target_date }));
      }
    }
  } catch (e) {
    console.warn("[vercel-milestone] failed:", (e as Error).message);
  }
  return [];
}

/**
 * Active-driver indicator.
 */
export function currentDriver(): "raw" | "vercel" {
  return config.llmDriver;
}
