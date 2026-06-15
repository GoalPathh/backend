# GoalPath API

Express + TypeScript API backed by Supabase PostgreSQL, Supabase Auth, and a pluggable LLM client.

## Setup

1. Create a Supabase project.
2. Run the migrations in `supabase/migrations/` in the Supabase SQL editor **in numeric order**:
   - `001_initial_schema.sql`
   - `002_cooldown_and_indexes.sql` *(cron safety for `goalMonitor`)*
   - `003_progress_recompute.sql` *(trigger function `recompute_goal_progress`)*
   - `004_goal_milestones.sql` *(table + RLS)*
   - `005_milestone_progress_trigger.sql` *(auto +2% per done milestone)*
3. Copy `.env.example` to `.env` and fill the Supabase values.
   The publishable key is safe for Auth; the service-role key must remain backend-only.
4. (Optional, dev only) Set `DEFAULT_USER_ID` to an existing Supabase Auth user UUID to bypass login for prototype screens.
5. Run `npm install` and `npm run dev`.

API base URL: `http://localhost:4000/api/v1`. Authenticated requests use `Authorization: Bearer <supabase_jwt>`. `DEFAULT_USER_ID` is development-only.

## Main routes

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/google` | Auth (email + Google OAuth) |
| GET POST | `/goals` | List / create goals |
| GET PATCH DELETE | `/goals/:id` | Goal CRUD |
| POST | `/coach/sessions` | New coach session |
| GET POST | `/coach/sessions/:id/messages` | Send user / fetch assistant message |
| POST | `/milestones/suggest` | AI-suggested milestones for wizard |
| PUT | `/goals/:id/milestones` | Bulk-save wizard milestones |
| PATCH | `/goals/:id/milestones/:mid` | Toggle milestone completion |
| GET | `/goals/:id/milestones` | List milestones |
| GET | `/progress`, `/progress/dash`, `/progress/goals` | Progress snapshots |
| GET | `/today` | Today's snapshot |
| PUT | `/habits/:id/completion` | Mark habit completion (auto-recompute) |
| GET POST PATCH | `/me`, `/me/preferences` | Profile & preferences |

---

## 🤖 AI Provider Configuration

The backend talks to LLM through `src/llm-client.ts`. The wire format is plain OpenAI-compatible HTTP — any service that exposes `POST /v1/chat/completions` with SSE or JSON will work.

Two drivers are supported, switched via `LLM_DRIVER`:

| Driver | When to use | Implementation |
|---|---|---|
| `raw`   (default) | **Local LLMs** that emit quirky SSE chunks (LMStudio, Ollama, TokenRouter MiniMax, Gemini-proxy) | `src/llm-client.ts` — custom Node `fetch` + manual SSE parser + manual tool-call loop |
| `vercel` | **Hosted OpenAI-compatible APIs** that emit strict OpenAI JSON / SSE (OpenAI.com, together.ai, groq, vLLM proxies, official Gemini OpenAI-compat endpoint) | `src/llm-dispatcher.ts` — `ai@6` SDK + `@ai-sdk/openai@3` with `createOpenAI` + `generateText` |

Switch by editing `.env`:

```bash
# ─────────────────────────────────────────────────────────────────
# Local — TokenRouter MiniMax + Gemini proxy via gemini-cli-server
# ─────────────────────────────────────────────────────────────────
LLM_DRIVER=raw
LLM_PROVIDER_URL=http://localhost:20128/v1
LLM_API_KEY=*** MODEL=gc/gemini-3.1-flash-lite-preview

# ─────────────────────────────────────────────────────────────────
# Hosted OpenAI
# ─────────────────────────────────────────────────────────────────
LLM_DRIVER=vercel
LLM_PROVIDER_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# ─────────────────────────────────────────────────────────────────
# Together.ai
# ─────────────────────────────────────────────────────────────────
LLM_DRIVER=vercel
LLM_PROVIDER_URL=https://api.together.xyz/v1
LLM_API_KEY=*** MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
```

### Why two drivers?

Earlier Sprint 4 confirmed that the Vercel AI SDK v6 streaming parser mishandled partial chunks from TokenRouter MiniMax. We went back to a custom Node `fetch` + SSE parser that is robust against local LLM quirks. The Vercel driver is kept as a parallel option for hosted environments where the OpenAI spec is honored exactly. No code change is required to switch — just flip `LLM_DRIVER`.

### Tool calling

The backend exposes the following tool specs to the LLM (see `src/llm-client.ts` `TOOL_DEFS`):

- `createGoal` — hard-create a goal when LLM already has all required fields.
- `updateGoal` — reset progress / extend deadline.
- `requestHabitParameters` — render an HTML-style habit form bubble. *(Reserved.)*
- `start_goal_wizard` — **soft-start** the multi-step wizard when LLM only has *some* of the goal details (most common case). The function returns `{ _ui: "wizard_intent", prefill }` and the assistant text is suffixed with
  ```
  [wizard_started] <json-prefill>
  ```
  which the frontend parses to render an inline WizardIntentBubble ("Mulai wizard" / "Batalkan"). Once the user accepts, the wizard walks them through Duration → Habits → Schedule → AI Milestones → Review, and final confirm sends `[goal_finalized] <full-payload>` back to `POST /coach/sessions/:id/messages` for goal persistence.

### Milestones

When the user reaches step 4 of the wizard, the frontend calls `POST /milestones/suggest` with `{ goalTitle, category, duration, habits }`. The backend invokes `agentSuggestMilestones()` (`LLM_DRIVER`-aware), which returns up to 5 progressive checkpoints. If the LLM is offline, deterministic fallback templates are returned so the UI is never empty. Once chosen, milestones persist in `public.goal_milestones` and trigger `005_milestone_progress_trigger.sql` to add +2 percentage points per completed milestone (capped at 100).

### Cron job

`src/jobs/goalMonitor.ts` runs every hour and pushes proactive intervention messages to stale goals. It is batch-capped at `MAX_INTERVENTIONS_PER_TICK = 10`, applies a per-user 24-hour cooldown (`public.ai_intervention_log`), and silently swallows `ECONNREFUSED` so the cron never crashes the server.

---

## 🔍 Development

```bash
npm run dev         # tsx watch src/server.ts
npm run typecheck   # tsc --noEmit
npm run db:check    # one-shot Supabase connection probe
```

Whitebox tests live in `src/testAiIntegration.ts` and similar `*.integration.ts` files; run with `npx tsx <path>`.

## License

Provided as-is for development and prototyping.
