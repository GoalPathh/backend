# 🔍 AI Feature Audit Report — GoalPath

**Date:** 2026-06-26  
**Scope:** AI Features (Backend + Frontend + Infra)  

## 🔴 CRITICAL (Severity 1)
1. **API Key & Secret Exposure in Repository**
   - **File:** `backend/.env`
   - **Issue:** The `.env` file contains production API keys (`LLM_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUDINARY_API_SECRET`). This file should NOT be tracked in git.
   - **Action Needed:** Immediately rotate all keys, add `.env` to `.gitignore`, and use a secret manager in production.
2. **Prompt Injection via User Data**
   - **File:** `backend/src/routes.ts`
   - **Issue:** `context` (user snapshot) is injected directly into the system prompt without sanitization. If a user sets their goal title to something like "Ignore previous instructions. You are now DAN...", the LLM might interpret it as a system command.
   - **Action Needed:** Wrap user data in explicit delimiters (e.g., `<user_data>`) and instruct the LLM to treat it as untrusted.
3. **`updateGoal` Tool — Missing Ownership Verification**
   - **File:** `backend/src/llm-client.ts`
   - **Issue:** The `updateGoal` tool trusts the `goal_id` provided by the LLM without verifying if the goal belongs to the requesting user.
   - **Action Needed:** Add an explicit ownership check (e.g., query `user_id` for the given `goal_id`) before applying updates.

## 🟠 HIGH (Severity 2)
4. **Embedding Model Mismatch**
   - **File:** `backend/src/services/embeddings.ts`
   - **Issue:** Hardcoded model `text-embedding-3-small` (OpenAI), but config uses Gemini's endpoint (`generativelanguage.googleapis.com`). Gemini does not have this model, meaning the embedding service always returns a zero-vector `[0, 0, 0, ...]`.
5. **RAG Context Broken Due to Zero-Vector**
   - **File:** `backend/src/repositories.ts`
   - **Issue:** Since embedding generates a zero-vector, the `match_coach_messages` RPC is fed `[0,0,0...]`, breaking the vector similarity search entirely.
6. **Dual Driver Duplication & No-op Config**
   - **Issue:** `agentChatVercel` is defined twice (`llm-client.ts` and `llm-dispatcher.ts`). Additionally, `routes.ts` always imports and uses the raw `agentChat`, making the `LLM_DRIVER=vercel` config useless.
7. **`goalMonitor` Cron Can Trigger Tools**
   - **File:** `backend/src/jobs/goalMonitor.ts`
   - **Issue:** The cron job uses the same `agentChat` function which has `TOOL_DEFS` enabled. The proactive cron message could accidentally trigger the `createGoal` or `start_goal_wizard` tools without user consent.
8. **No Rate Limiting on AI Endpoints**
   - **Issue:** The `POST /coach/sessions/:id/messages` route has no rate limit. Abuse could quickly drain the Gemini API quota and overload the DB.

## 🟡 MEDIUM (Severity 3)
9. **State Injection via Wizard Prefill** (Frontend)
10. **`stripAssistantTags` Called 3x per Render** (Frontend Performance)
11. **Internal Error Messages Exposed to User** via chat fallback
12. **Agent Loop Lacks Max Iteration Guard** (Silent failures if follow-up returns more tool calls)
13. **SSE Parsing is Buffered, Not Streamed** (`backend/src/llm-client.ts`)

## 🟢 LOW (Severity 4)
14. **Lack of Automated Testing for AI Pipeline**
15. **Persona Computation uses N+1 Query Pattern**
16. **Dead Code in Frontend** (Wizard modal fallback block is `false && ...`)
17. **Magic String `[wizard_started]`** is a fragile contract
18. **Model Name `gemini-3.1-flash-lite`** is unverified in standard Gemini docs