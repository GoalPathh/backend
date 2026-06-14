/**
 * Unified LLM Client — handles SSE streaming + non-streaming JSON
 * Works with OpenAI-compatible, Gemini, LMStudio, Ollama, MiniMax-M3
 */

import { config } from "./config.js";
import { GoalRepository } from "./repositories.js";

// ── Tool definitions for LLM tool calling ──
export const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "createGoal",
      description: "Create a new goal for the user. Call when user wants to start a new goal.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short goal title" },
          category: {
            type: "string",
            enum: ["language", "fitness", "skills", "creativity", "learning", "other"],
            description: "Goal category"
          },
          period: {
            type: "string",
            enum: ["1month", "3months", "6months", "1year"],
            default: "3months",
            description: "Goal timeframe"
          },
          habit_title: { type: "string", description: "A single habit to track" }
        },
        required: ["title", "category"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "updateGoal",
      description: "Update an existing goal: reset progress or extend deadline.",
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "UUID of goal to update" },
          action: { type: "string", enum: ["reset_progress", "extend_deadline"] }
        },
        required: ["goal_id", "action"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "requestHabitParameters",
      description: "Ask the user to provide specific details for a habit via interactive UI form.",
      parameters: {
        type: "object",
        properties: {
          goal_title: { type: "string", description: "The goal name" },
          suggested_habit: { type: "string", description: "A suggested habit name" }
        },
        required: ["goal_title"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "start_goal_wizard",
      description:
        "Open the interactive multi-step wizard for creating a new goal. Call this whenever the user expresses intent to start a new goal " +
        "(e.g. 'I want to learn Spanish', 'bikin goal fitness 3 bulan', 'set a new goal', 'mau mulai goal baru'). " +
        "Extract any details mentioned in the user's message — duration, category, hint, suggested habit titles — and pass them as parameters. " +
        "Leave parameters null when not mentioned; the UI will collect the rest. Do NOT call this on every message; only on intent.",
      parameters: {
        type: "object",
        properties: {
          hint: { type: "string", description: "Short restatement of what user wants (1-2 sentences)" },
          duration: {
            type: "string",
            enum: ["1month", "3months", "6months", "1year"],
            description: "Timeframe inferred from user message"
          },
          prefilled_category: {
            type: "string",
            enum: ["language", "fitness", "skills", "creativity", "learning", "other"],
            description: "Category inferred from keyword analysis"
          },
          prefilled_title: {
            type: "string",
            description: "Title the user said, if any (e.g. 'Learn English')"
          },
          prefilled_habits: {
            type: "array",
            description: "Habits the user named in the message",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                difficulty: { type: "string", enum: ["easy", "medium", "hard"] }
              },
              required: ["title"]
            }
          }
        }
      }
    }
  }
];

// ── Tool execution ──
async function executeTool(userId: string, name: string, args: any): Promise<{ ok: boolean; message: string; data?: any }> {
  const goalRepo = new GoalRepository();

  if (name === "createGoal") {
    // Title can come from `title` OR `habit_title` (LLM sometimes confuses these)
    const rawTitle = (args.title || args.goal_title || args.habit_title || "").toString().trim();
    if (!rawTitle) {
      return { ok: false, message: "Missing required field 'title' (what do you want to call this goal?)" };
    }
    if (!args.category) {
      return { ok: false, message: "Missing required field 'category' (e.g., fitness, language, learning)" };
    }

    const title = rawTitle;
    const category = args.category;
    const period = args.period || "3months";
    // If LLM used single param for both, treat it as the title and synthesize a habit
    const habitTitle = title.toLowerCase().startsWith(args.habit_title?.toLowerCase() ?? "")
      ? `Daily practice: ${title}`
      : (args.habit_title?.trim() || `Daily practice: ${title}`);

    let durationDays = 90;
    if (period === "1month") durationDays = 30;
    else if (period === "6months") durationDays = 180;
    else if (period === "1year") durationDays = 365;

    const startDate = new Date().toISOString();
    const targetDate = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

    const result = await goalRepo.create(userId, {
      title, category, period, progress: 0,
      startDate, targetDate,
      reminderEnabled: true,
      notificationPreference: "all",
      selectedHabits: [{
        title: habitTitle, duration: 30, difficulty: "medium",
        schedule: { timeRange: "anytime", activeDays: ["mon", "tue", "wed", "thu", "fri"], priority: "medium" }
      }]
    });

    console.log(`[Tool] createGoal: "${title}" (${result.id}) for user ${userId}`);
    return {
      ok: true,
      message: `Goal "${title}" created successfully with habit "${habitTitle}".`,
      data: { goalId: result.id, title, category }
    };
  }

  if (name === "updateGoal") {
    if (!args.goal_id) return { ok: false, message: "Missing required field 'goal_id'" };
    if (!args.action) return { ok: false, message: "Missing required field 'action'" };

    const updates: Record<string, any> = {};
    if (args.action === "reset_progress") updates.progress = 0;
    else if (args.action === "extend_deadline") {
      updates.targetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    } else {
      return { ok: false, message: `Unknown action: ${args.action}` };
    }

    await goalRepo.update(userId, args.goal_id, updates);
    console.log(`[Tool] updateGoal: ${args.goal_id} action=${args.action}`);
    return { ok: true, message: `Goal updated successfully.` };
  }

  if (name === "requestHabitParameters") {
    return {
      ok: true,
      message: `Interactive habit form requested. UI status: RENDERED.`,
      data: { _ui: "habit_form", goal_title: args.goal_title, suggested_habit: args.suggested_habit }
    };
  }

  if (name === "start_goal_wizard") {
    // No DB write — just signal frontend to render the multi-step wizard bubble.
    const prefill = {
      hint: typeof args.hint === "string" ? args.hint.trim() : null,
      duration: typeof args.duration === "string" ? args.duration : null,
      category: typeof args.prefilled_category === "string" ? args.prefilled_category : null,
      title: typeof args.prefilled_title === "string" ? args.prefilled_title.trim() : null,
      habits: Array.isArray(args.prefilled_habits)
        ? args.prefilled_habits.filter((h: any) => h && typeof h.title === "string").map((h: any) => ({
            title: String(h.title).trim(),
            difficulty: typeof h.difficulty === "string" ? h.difficulty : "medium",
          }))
        : [],
    };
    return {
      ok: true,
      message: `Wizard opened. UI status: WIZARD_PREFILL.`,
      data: { _ui: "wizard_intent", prefill },
    };
  }

  return { ok: false, message: `Unknown tool: ${name}` };
}

function stripReasoning(text: string): string {
  if (!text) return "";
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Robust LLM fetch with SSE parsing and timeouts
 */
async function fetchLLM(messages: any[], tools?: any[]): Promise<any> {
  const url = `${config.llmProviderUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: any = {
    model: config.llmModel,
    messages
  };
  if (tools) body.tools = tools;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      throw new Error(`LLM API returned ${resp.status} ${resp.statusText}`);
    }

    const contentType = resp.headers.get("content-type") || "";

    // FORMAT 1: SSE Streaming (text/event-stream)
    if (contentType.includes("event-stream")) {
      const rawText = await resp.text();
      // Split by 'data: ' and parse each chunk
      const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.startsWith('data: '));
      
      let finalContent = "";
      const toolCalls: Record<number, any> = {};

      for (const line of lines) {
        const dataStr = line.substring(6).trim();
        if (dataStr === '[DONE]') break;
        
        try {
          const chunk = JSON.parse(dataStr);
          const delta = chunk.choices?.[0]?.delta;
          
          if (!delta) continue;

          if (delta.content) finalContent += delta.content;
          
          // Handle tool calls streaming
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: tc.type, function: { name: "", arguments: "" } };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.type) toolCalls[idx].type = tc.type;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch { /* Ignore malformed chunks */ }
      }

      const parsedToolCalls = Object.values(toolCalls);
      
      return {
        message: {
          content: finalContent,
          ...(parsedToolCalls.length > 0 && { tool_calls: parsedToolCalls })
        }
      };
    } 
    
    // FORMAT 2: Standard JSON (application/json)
    else {
      const json = await resp.json() as any;
      if (!json.choices?.[0]?.message) {
        throw new Error("Invalid non-streaming JSON structure");
      }
      return json.choices[0];
    }
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Main Agent orchestrator
 */
export async function agentChat(systemPrompt: string, messages: any[], userId: string): Promise<string> {
  const fullMessages = [
    { role: "system", content: systemPrompt },
    ...messages
  ];

  // 1. Initial Call
  const response = await fetchLLM(fullMessages, TOOL_DEFS);
  const choiceMsg = response.message;

  // 2. Check for Tools
  if (choiceMsg.tool_calls && choiceMsg.tool_calls.length > 0) {
    const toolResults: any[] = [];
    const uiDataList = [];
    let isUserFacingError = false;

    // Execute all tool calls
    for (const tc of choiceMsg.tool_calls) {
      const fnName = tc.function?.name;
      let fnArgs: any = {};
      try {
        fnArgs = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        console.error(`[LLM] Malformed tool arguments:`, tc.function?.arguments);
        toolResults.push({ ok: false, message: "Error: Tool arguments are not valid JSON." });
        isUserFacingError = true;
        continue;
      }

      console.log(`[LLM] Executing Tool: ${fnName}(${JSON.stringify(fnArgs)})`);
      const result = await executeTool(userId, fnName, fnArgs);
      toolResults.push(result);
      if (result.data) uiDataList.push(result.data);
    }

    // 3. Follow-up Call (Supply tool results back to LLM)
    const followUpMessages = [
      ...fullMessages,
      { 
        role: "assistant", 
        content: choiceMsg.content || "", 
        tool_calls: choiceMsg.tool_calls 
      },
      ...choiceMsg.tool_calls.map((tc: any, i: number) => ({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(toolResults[i])
      }))
    ];

    try {
      const followUpResponse = await fetchLLM(followUpMessages);
      const followTextRaw = stripReasoning(followUpResponse.message?.content || "");

      // If the follow-up produced no text AND there were tool errors, surface that
      // honestly rather than the misleading "completed successfully" string.
      const hadToolFailure = toolResults.some((r) => r.ok === false);
      if (!followTextRaw && hadToolFailure) {
        const failures = toolResults
          .filter((r) => r.ok === false)
          .map((r) => r.message)
          .join("; ");
        return `I started creating your goal but needed a bit more info: ${failures}. Could you confirm the goal title and a couple of details?`;
      }
      if (!followTextRaw) {
        return "I've recorded that for you — anything else you'd like to set up?";
      }

      let text = followTextRaw;

      if (uiDataList.length > 0) {
        // If we generated UI data, prepend it as a serialized payload block
        // (Frontend can parse this later if needed)
        const uiPayload = uiDataList.map(d => {
          // Wizard intent: emit a dedicated, easily-grepped tag for the frontend
          if (d?._ui === "wizard_intent" && d.prefill) {
            return `[wizard_started] ${JSON.stringify(d.prefill)}`;
          }
          return `[UI_DATA: ${JSON.stringify(d)}]`;
        }).join("\n");
        text = text ? `${uiPayload}\n\n${text}` : uiPayload;
      }

      return text;
    } catch (e) {
      console.error("[LLM] Follow-up failed:", e);
      const hadToolFailure = toolResults.some((r) => r.ok === false);
      if (hadToolFailure) {
        return "I'm having a small hiccup confirming that. Could you try again with the goal title spelled out?";
      }
      return "I've successfully updated your goals based on what we discussed!";
    }
  }

  // No tools, just text
  return stripReasoning(choiceMsg.content || "");
}

// ── Milestone suggestion (used by wizard step "schedule" in coach flow) ──
export interface SuggestedMilestone {
  title: string;
  target_date?: string; // ISO date
}

function deriveFallbackMilestones(
  goalTitle: string,
  duration: string,
  categories: string[]
): SuggestedMilestone[] {
  const weeks = duration === "1month" ? 4 : duration === "3months" ? 12 : duration === "6months" ? 24 : 52;
  const now = Date.now();
  const stepMs = (weeks * 7 * 24 * 3600 * 1000) / Math.max(3, 4);
  const templates: Array<{ after: number; label: string }> = [
    { after: 0, label: "Mulai rutin dan capai baseline kecil" },
    { after: 1, label: "Konsisten 1 minggu penuh" },
    { after: 2, label: "Evaluasi progres dan tweak kebiasaan" },
    { after: 3, label: "Capai tonggak utama" },
  ];
  if (categories.some((c) => /language|english|spanish|french|german|learn/i.test(c))) {
    templates[3]!.label = "Punya percakapan dasar yang lancar";
  } else if (categories.some((c) => /fitness|gym|run|lose|weight/i.test(c))) {
    templates[3]!.label = "Capai target kebugaran utama";
  } else if (categories.some((c) => /skill|code|coding|learn/i.test(c))) {
    templates[3]!.label = "Selesaikan proyek kecil dengan skill baru";
  }
  return templates.map((t, idx) => ({
    title: `[${goalTitle || "Goal"}] ${t.label}`,
    target_date: new Date(now + Math.round(idx * stepMs)).toISOString(),
  }));
}

export async function agentSuggestMilestones(opts: {
  goalTitle: string;
  category?: string;
  duration?: string;
  habits?: { title: string; difficulty?: string }[];
}): Promise<SuggestedMilestone[]> {
  const sys = `You are a GoalPath milestone planner.
Given a user's goal, category, duration, and habits, propose 3 to 5 concrete progressive milestones.
Rules:
- Each milestone MUST be a concrete actionable step.
- Output VALID JSON ONLY (no markdown fences, no commentary).
- Schema: {"milestones":[{"title":"<short action>", "target_date":"<optional ISO date YYYY-MM-DD>"}]}
- Aim for 3-5 items, distributed across the goal period.
- Respect user's existing habits — milestones should not duplicate them.
- Write in the SAME LANGUAGE as the goal title.`;

  const habitLines = (opts.habits ?? []).slice(0, 5).map((h) => `- ${h.title} (${h.difficulty ?? "n/a"})`).join("\n");
  const userPrompt =
    `Goal: ${opts.goalTitle}\n` +
    `Category: ${opts.category ?? "other"}\n` +
    `Duration: ${opts.duration ?? "3months"}\n` +
    `Habits:\n${habitLines || "(none yet)"}`;

  let parsed: SuggestedMilestone[] | null = null;
  try {
    const resp = await fetchLLM(
      [{ role: "user", content: userPrompt }],
      [], // no tools
    );
    const raw = stripReasoning(resp.message?.content || "");
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object in LLM reply");
    const obj = JSON.parse(jsonMatch[0]);
    if (Array.isArray(obj?.milestones)) {
      parsed = obj.milestones
        .filter((m: any) => m && typeof m.title === "string" && m.title.trim().length >= 3)
        .slice(0, 5)
        .map((m: any, idx: number) => ({
          title: m.title.trim(),
          target_date: typeof m.target_date === "string" ? m.target_date : undefined,
        }));
    }
  } catch (e) {
    console.warn("[agentSuggestMilestones] LLM unavailable or bad output, using fallback:", (e as Error).message);
  }

  if (!parsed || parsed.length === 0) {
    return deriveFallbackMilestones(
      opts.goalTitle,
      opts.duration ?? "3months",
      [opts.category ?? "", ...(opts.habits ?? []).map((h) => h.title)]
    );
  }
  return parsed;
}

// ── Vercel AI SDK provider (optional) ──
// Activated when LLM_PROVIDER=vercel. Falls back to "raw" (default) otherwise.
// Works with any baseURL exposing POST /v1/chat/completions OpenAI-style —
// including OpenAI, Anthropic-via-proxy, Groq, Together, OpenRouter, vLLM.
import { createOpenAI } from "@ai-sdk/openai";

// Lazy-init so module-load doesn't fail if config missing
let _openaiProvider: ReturnType<typeof createOpenAI> | null = null;
function openaiProvider() {
  if (!_openaiProvider) {
    _openaiProvider = createOpenAI({
      baseURL: config.llmProviderUrl,
      apiKey: config.llmApiKey,
    });
  }
  return _openaiProvider;
}

/**
 * Vercel AI SDK wrapper. Uses `generateText` which handles tool-calls natively.
 * Auto-strips `<think>…</think>` reasoning blocks (Gemini / DeepSeek thinking mode).
 */
export async function agentChatVercel(
  systemPrompt: string,
  messages: any[],
): Promise<string> {
  const { generateText } = await import("ai");

  const result = await generateText({
    model: openaiProvider().chat(config.llmModel),
    system: systemPrompt,
    messages: messages.map((m: any) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: m.content,
    })),
  });

  const text = (result.text ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!text) throw new Error("Vercel SDK returned empty text");
  return text;
}
