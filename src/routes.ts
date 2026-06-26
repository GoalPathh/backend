import { Router } from "express";
import { z } from "zod";
import { requireUser } from "./middleware.js";
import {
  authSchema,
  completionSchema,
  coachSessionUpdateSchema,
  forgotPasswordSchema,
  goalSchema,
  GOAL_WIZARD_TAG,
  oauthSchema,
  personaWindowDaysSchema,
  progressRangeSchema,
  preferencesSchema,
  profileSchema,
  refreshSessionSchema,
  registerSchema,
  updatePasswordSchema,
  updateGoalSchema,
  wizardGoalPayloadSchema,
} from "./schemas.js";
import { AuthService, CoachService, DashboardService, GoalService, MilestoneService, NotificationService, PersonaService, UserService } from "./services.js";
import { agentChat, agentSuggestMilestones } from "./llm-client.js";
import { currentDriver } from "./llm-dispatcher.js";
import { GoalRepository } from "./repositories.js";
import { AppError } from "./errors.js";
import { generateEmbedding } from "./services/embeddings.js";

const setAuthCookies = (res: any, data: any) => {
  if (data?.session) {
    res.cookie("goalpath_access_token", data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: data.session.expires_in * 1000,
    });
    res.cookie("goalpath_refresh_token", data.session.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
  }
};

export const apiRouter=Router(); const auth=new AuthService(),goals=new GoalService(),users=new UserService(),dashboard=new DashboardService(),notifications=new NotificationService(),coach=new CoachService(),milestones=new MilestoneService(),persona=new PersonaService(); const id=z.string().uuid();
apiRouter.get("/health",(_q,r)=>r.json({data:{status:"ok",service:"goalpath-api",llm_driver:currentDriver()}}));
apiRouter.post("/auth/register",async(q,r)=>{const data=await auth.register(registerSchema.parse(q.body));setAuthCookies(r,data);r.status(201).json({data})});
apiRouter.post("/auth/login",async(q,r)=>{const data=await auth.login(authSchema.parse(q.body));setAuthCookies(r,data);r.json({data})});
apiRouter.post("/auth/refresh",async(q,r)=>{const token=q.cookies?.goalpath_refresh_token||refreshSessionSchema.parse(q.body).refreshToken;const data=await auth.refresh(token);setAuthCookies(r,data);r.json({data})});
apiRouter.post("/auth/google",async(q,r)=>r.json({data:await auth.googleOAuth(oauthSchema.parse(q.body).next)}));
apiRouter.post("/auth/logout",async(q,r)=>{r.clearCookie("goalpath_access_token");r.clearCookie("goalpath_refresh_token");r.json({data:{success:true}})});
apiRouter.post("/auth/forgot-password",async(q,r)=>r.json({data:await auth.forgotPassword(forgotPasswordSchema.parse(q.body).email)}));
apiRouter.post("/auth/password",requireUser,async(q,r)=>r.json({data:await auth.updatePassword(q.userId!,updatePasswordSchema.parse(q.body).password)}));
apiRouter.get("/goals",requireUser,async(q,r)=>r.json({data:await goals.list(q.userId!)}));
apiRouter.get("/goals/dashboard",requireUser,async(q,r)=>r.json({data:await goals.dashboard(q.userId!)}));
apiRouter.get("/goals/:id",requireUser,async(q,r)=>r.json({data:await goals.get(q.userId!,id.parse(q.params.id))}));
apiRouter.post("/goals",requireUser,async(q,r)=>r.status(201).json({data:await goals.create(q.userId!,goalSchema.parse(q.body))}));
apiRouter.patch("/goals/:id",requireUser,async(q,r)=>r.json({data:await goals.update(q.userId!,id.parse(q.params.id),updateGoalSchema.parse(q.body))}));
apiRouter.delete("/goals/:id",requireUser,async(q,r)=>{await goals.remove(q.userId!,id.parse(q.params.id));r.status(204).send()});
apiRouter.get("/me/overview",requireUser,async(q,r)=>r.json({data:await users.overview(q.userId!)}));
apiRouter.get("/me",requireUser,async(q,r)=>r.json({data:await users.profile(q.userId!)}));
apiRouter.patch("/me",requireUser,async(q,r)=>r.json({data:await users.updateProfile(q.userId!,profileSchema.parse(q.body))}));
apiRouter.post("/me/avatar/signature",requireUser,async(q,r)=>r.json({data:await users.avatarUploadSignature(q.userId!)}));
apiRouter.get("/me/preferences",requireUser,async(q,r)=>r.json({data:await users.preferences(q.userId!)}));
apiRouter.patch("/me/preferences",requireUser,async(q,r)=>r.json({data:await users.updatePreferences(q.userId!,preferencesSchema.parse(q.body))}));
apiRouter.get("/today",requireUser,async(q,r)=>{const tzOffset=q.query.tzOffset?parseInt(q.query.tzOffset as string,10):undefined;r.json({data:await dashboard.today(q.userId!,tzOffset)})});
apiRouter.put("/habits/:id/completion",requireUser,async(q,r)=>{const input=completionSchema.parse(q.body);r.json({data:await dashboard.setCompletion(q.userId!,id.parse(q.params.id),input.completed,input.completionDate)})});
apiRouter.get("/progress",requireUser,async(q,r)=>r.json({data:await dashboard.getUserContextSnapshot(q.userId!)}));
apiRouter.get("/progress/overview",requireUser,async(q,r)=>{const {range}=progressRangeSchema.parse(q.query);r.json({data:await dashboard.progressOverview(q.userId!,range)});});
apiRouter.get("/progress/dash",requireUser,async(q,r)=>r.json({data:await dashboard.progressDash(q.userId!)}));
apiRouter.get("/progress/goals",requireUser,async(q,r)=>r.json({data:await dashboard.goalPerformance(q.userId!)}));
apiRouter.post("/progress/recompute/:goalId",requireUser,async(q,r)=>{const goalId=z.string().uuid().parse(q.params.goalId);return r.json({data:await dashboard.recomputeGoal(q.userId!,goalId)});});
apiRouter.get("/progress/persona",requireUser,async(q,r)=>{const w=personaWindowDaysSchema.parse(q.query.windowDays);return r.json({data:await persona.compute(q.userId!,w)});});
apiRouter.post("/progress/persona/refresh",requireUser,async(q,r)=>{const w=personaWindowDaysSchema.parse((q.body&&(q.body as any).windowDays)||q.query.windowDays);return r.json({data:await persona.compute(q.userId!,w,true)});});
apiRouter.get("/notifications",requireUser,async(q,r)=>r.json({data:await notifications.list(q.userId!)}));
apiRouter.patch("/notifications/read-all",requireUser,async(q,r)=>r.json({data:await notifications.markAllRead(q.userId!)}));
apiRouter.get("/coach/sessions",requireUser,async(q,r)=>r.json({data:await coach.sessions(q.userId!)}));
apiRouter.post("/coach/sessions",requireUser,async(q,r)=>r.status(201).json({data:await coach.createSession(q.userId!,z.object({title:z.string().min(1).max(120).optional()}).parse(q.body).title)}));
apiRouter.patch("/coach/sessions/:id",requireUser,async(q,r)=>{const sid=id.parse(q.params.id);const body=coachSessionUpdateSchema.parse(q.body);const updated=await coach.renameSession(q.userId!,sid,body.title);return r.json({data:updated});});
apiRouter.delete("/coach/sessions/:id",requireUser,async(q,r)=>{const sid=id.parse(q.params.id);await coach.deleteSession(q.userId!,sid);return r.status(204).send();});
apiRouter.get("/coach/sessions/:id",requireUser,async(q,r)=>r.json({data:await coach.session(q.userId!,id.parse(q.params.id))}));
apiRouter.get("/coach/sessions/:id/messages",requireUser,async(q,r)=>r.json({data:await coach.messages(q.userId!,id.parse(q.params.id))}));
apiRouter.get("/coach/quota",requireUser,async(q,r)=>r.json({data:await coach.getQuota(q.userId!)}));

// ── Coach message endpoint ──
apiRouter.post("/coach/sessions/:id/messages",requireUser,async(q,r)=>{
  const userId = q.userId!;
  const sessionId = id.parse(q.params.id);
  const input = z.object({
    role: z.enum(["user","assistant"]).default("user"),
    content: z.string().min(1).max(20000)
  }).parse(q.body);

  // --- RATE LIMIT GUARD: Max 50 messages per 3 hours ---
  const quota = await coach.getQuota(userId);
  if (quota.remaining_messages <= 0 && quota.reset_at) {
    const now = new Date().getTime();
    const resetTime = new Date(quota.reset_at).getTime();
    if (now < resetTime) {
      throw new AppError("Limit percakapan tercapai (Maks 50 pesan per 3 jam). Silakan coba lagi nanti.", 429);
    }
  }
  // -----------------------------------------------------

  // 0. Detect interactive Goal Wizard submit (skip LLM, persist directly)
  if (input.content.startsWith(GOAL_WIZARD_TAG)) {
    try {
      const jsonPart = input.content.slice(GOAL_WIZARD_TAG.length).trim();
      let parsed: unknown;
      try { parsed = JSON.parse(jsonPart); }
      catch { throw new AppError("Wizard payload is not valid JSON.", 400); }

      const payload = wizardGoalPayloadSchema.parse(parsed);

      // Backend-level required-field check
      const activeDays = payload.schedule?.activeDays ?? [];
      if (!payload.duration) throw new AppError("Wizard payload missing required field: duration", 400);
      if (!payload.habits || payload.habits.length === 0) {
        throw new AppError("Wizard payload requires at least 1 habit", 400);
      }
      if (activeDays.length === 0) {
        throw new AppError("Wizard payload requires at least 1 active day in schedule", 400);
      }

      let durationDays = 90;
      if (payload.duration === "1month") durationDays = 30;
      else if (payload.duration === "6months") durationDays = 180;
      else if (payload.duration === "1year") durationDays = 365;

      const startDate = new Date().toISOString();
      const targetDate = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

      const title = payload.title?.trim() && payload.title.trim().length >= 2
        ? payload.title.trim()
        : payload.habits[0]!.title;

      const category = payload.category ?? "other";

      const goalRepo = new GoalRepository();
      const created = await goalRepo.create(userId, {
        title,
        category,
        period: payload.duration,
        progress: 0,
        startDate,
        targetDate,
        reminderEnabled: true,
        notificationPreference: payload.notifications,
        selectedHabits: payload.habits.map((h) => ({
          title: h.title,
          duration: h.duration_minutes,
          difficulty: h.difficulty,
          schedule: {
            timeRange: payload.schedule?.reminderTime ? "evening" : "anytime",
            reminderTime: payload.schedule?.reminderTime || null,
            activeDays: activeDays,
            priority: "medium" as const,
          },
        })),
        selectedMilestones: Array.isArray(payload.milestones)
          ? payload.milestones.slice(0, 12).map((m: any, idx: number) => ({
              title: String(m.title ?? "").trim(),
              target_date: m.target_date ?? null,
              sort_order: typeof m.sort_order === "number" ? m.sort_order : idx,
            })).filter((m: any) => m.title.length >= 3)
          : [],
      });

      await coach.addMessage(userId, sessionId, "user", input.content);
      const habitSummary = payload.habits.map(h => `• ${h.title} (${h.duration_minutes}m, ${h.difficulty})`).join("\n");
      const daySummary = activeDays.join(", ");
      const reply = `🎯 Goal "${(created as any).title}" berhasil dibuat!\n\nKebiasaan:\n${habitSummary}\n\nAktif: ${daySummary}${payload.schedule?.reminderTime ? ` • ${payload.schedule.reminderTime}` : ""}`;
      const assistantMsg = await coach.addMessage(userId, sessionId, "assistant", reply);
      return r.status(201).json({ data: assistantMsg });
    } catch (err) {
      console.error("[Wizard] Error:", err);
      await coach.addMessage(userId, sessionId, "assistant",
        err instanceof Error ? `Wizard error: ${err.message}. Please try the wizard again with all required fields.` : "Wizard error: unknown."
      );
      throw err;
    }
  }

  // 1. Generate embedding & persist user message
  const userEmbedding = await generateEmbedding(input.content);
  await coach.addMessage(userId, sessionId, input.role, input.content, userEmbedding);

  // 2. Fetch history & RAG context
  const RECENT_CHAT_CONTEXT_LIMIT = 10;
  const SEMANTIC_MATCH_LIMIT = 5;

  const history = await coach.messages(userId, sessionId);
  const semanticMatches = await coach.searchContext(userId, sessionId, userEmbedding, SEMANTIC_MATCH_LIMIT);
  const context = await dashboard.getUserContextSnapshot(userId);

  // 3. Build messages for LLM
  // We keep the last RECENT_CHAT_CONTEXT_LIMIT exchanges, plus the latest user message
  const messages = history.slice(-(RECENT_CHAT_CONTEXT_LIMIT + 1)).map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content
  }));
  
  // Format deterministic RAG block to avoid mixing semantic memory directly into the current message text
  let semanticBlock = "";
  if (semanticMatches.length > 0) {
    semanticBlock = "Relevant past messages:\n" + semanticMatches.map((m: any) => `[Historical ${m.role}]: ${m.content}`).join("\n") + "\n\n";
  }

  const personaContext = await persona.getCoachContext(userId, 14).catch((e) => {
    console.warn("[coach] persona context best-effort failed:", (e as Error).message);
    return "";
  });

  const systemPrompt = `You are a smart AI Coach for GoalPath.
You help users plan goals and maintain habits.

${personaContext ? `<PersonaContext>\n${personaContext}\n</PersonaContext>\n` : ""}${semanticBlock}Current User Data (STRICT SOURCE OF TRUTH):
${JSON.stringify(context, null, 2)}

Rules:
- Adapt your tone to the user's persona archetype above — keep the tone matched to ${personaContext ? "their style. " : "their context."}Mention suggested next milestone in passing when appropriate; never override the user's stated choices.
- DO NOT hallucinate dates or progress.
- When user expresses INTENT to set up a new goal (eg. "bikin goal baru", "I want to track", "mau mulai fitness 3 bulan", "let's set a goal", "set up a goal", "saya mau belajar Spanish"), call the start_goal_wizard tool — even if some details are missing. Pass any details the user mentioned as parameters; leave others null. After this tool call, briefly tell the user you'll open the wizard.
- Otherwise, when the goal is mostly planned and you have title + category, call the createGoal tool directly.
- When user wants to update a goal, call the updateGoal tool.
- When you need to ask user for duration/days/difficulty of a habit, call requestHabitParameters tool.
- Keep responses encouraging and concise.
- Always respond in the same language the user writes in.`;

  try {
    // 4. Consume quota before calling the expensive LLM API
    await coach.consumeQuota(userId);

    const aiText = await agentChat(systemPrompt, messages, userId);
    const assistantMsg = await coach.addMessage(userId, sessionId, "assistant", aiText);
    return r.status(201).json({ data: assistantMsg });
  } catch (err: any) {
    console.error("AI Error:", err.message);
    const fallback = "I'm having a brief connection hiccup. Could you try sending that again?";
    const assistantMsg = await coach.addMessage(userId, sessionId, "assistant", fallback);
    r.status(201).json({ data: assistantMsg });
  }
});

// ── Milestone routes ──
const suggestMilestonesBodySchema = z.object({
  goalTitle: z.string().min(2).max(160),
  category: z.string().max(40).optional(),
  duration: z.string().max(20).optional(),
  habits: z.array(z.object({ title: z.string(), difficulty: z.string().optional() })).max(20).optional(),
});
apiRouter.post("/milestones/suggest", requireUser, async (q, r) => {
  const body = suggestMilestonesBodySchema.parse(q.body);
  const milestones = await agentSuggestMilestones(body);
  return r.json({ data: { milestones, source: "ai+fallback" } });
});

const milestoneItemSchema = z.object({
  title: z.string().min(3).max(200),
  target_date: z.string().datetime().optional(),
  sort_order: z.number().int().min(0).max(20).optional(),
});
const milestonesBulkSchema = z.object({
  milestones: z.array(milestoneItemSchema).min(1).max(12),
});
apiRouter.put("/goals/:id/milestones", requireUser, async (q, r) => {
  const userId = q.userId!;
  const goalId = id.parse(q.params.id);
  await new GoalRepository().find(userId, goalId); // owner check
  const body = milestonesBulkSchema.parse(q.body);
  const rows = await milestones.bulkReplace(userId, goalId, body.milestones);
  return r.json({ data: rows });
});

apiRouter.patch("/goals/:id/milestones/:milestoneId", requireUser, async (q, r) => {
  const userId = q.userId!;
  const goalId = id.parse(q.params.id);
  const milestoneId = id.parse(q.params.milestoneId);
  const body = z.object({ completed: z.boolean() }).parse(q.body);
  const updated = await milestones.setDone(userId, milestoneId, body.completed);
  // Recompute progress explicitly (trigger should handle it, but explicit doesn't hurt)
  await dashboard.recomputeGoal(userId, goalId);
  return r.json({ data: updated });
});

apiRouter.get("/goals/:id/milestones", requireUser, async (q, r) => {
  const userId = q.userId!;
  const goalId = id.parse(q.params.id);
  await new GoalRepository().find(userId, goalId); // owner check
  const rows = await milestones.listOf(userId, goalId);
  return r.json({ data: rows });
});
