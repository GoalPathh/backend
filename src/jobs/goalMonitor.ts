import cron from "node-cron";
import { supabaseAdmin } from "../supabase.js";
import { CoachRepository, DashboardRepository } from "../repositories.js";
import { agentChat } from "../llm-client.js";

// Tunables
const MAX_INTERVENTIONS_PER_TICK = 10;       // Bug #8: cap LLM calls per cron tick
const COOLDOWN_HOURS = 24;                  // Bug #9: minimum gap between interventions per user
const STAGNANT_MIN_AGE_DAYS = 1;            // skip goals created in the last day

export function initGoalMonitorJob() {
  cron.schedule("0 * * * *", async () => {
    console.log("[Goal Monitor Job] Running check for stagnant goals...");
    const tickStart = Date.now();

    try {
      const now = new Date();
      const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const cooldownCutoff = new Date(now.getTime() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
      const minStartDate = new Date(now.getTime() - STAGNANT_MIN_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Fetch ALL stagnant goals in one query (admin client — no JWT, bypasses RLS)
      const { data: goals, error } = await supabaseAdmin
        .from("goals")
        .select("id, title, user_id, progress, start_date, target_date")
        .lte("start_date", minStartDate); // skip brand-new goals

      if (error) throw error;
      if (!goals || goals.length === 0) return;

      const stagnantGoals = goals.filter((g) => {
        const progressNum = Number(g.progress);
        const isUrgentStagnant = progressNum < 30 && g.target_date <= threeDaysLater;
        const isColdStartStagnant = progressNum === 0;
        return isUrgentStagnant || isColdStartStagnant;
      });

      if (stagnantGoals.length === 0) return;

      // Bug #8: hard-cap interventions per tick
      const queue = stagnantGoals.slice(0, MAX_INTERVENTIONS_PER_TICK);
      console.log(`[Goal Monitor Job] ${stagnantGoals.length} stagnant found — processing top ${queue.length}`);

      // Group by user so we only intervene once per user per tick (Bug #9 prep)
      const byUser = new Map<string, typeof queue>();
      for (const g of queue) {
        if (!g.user_id) continue;
        const arr = byUser.get(g.user_id) ?? [];
        arr.push(g);
        byUser.set(g.user_id, arr);
      }

      // Bug #9: filter out users who already received intervention within COOLDOWN_HOURS
      const userIds: string[] = Array.from(byUser.keys());
      if (userIds.length === 0) {
        console.log("[Goal Monitor Job] No eligible users with stagnant goals.");
        return;
      }
      const { data: recent } = await supabaseAdmin
        .from("ai_intervention_log")
        .select("user_id, created_at")
        .in("user_id", userIds)
        .gte("created_at", cooldownCutoff);

      const recentByUser = new Map<string, string>();
      for (const row of recent ?? []) {
        if (!row.user_id || recentByUser.has(row.user_id)) continue;
        recentByUser.set(row.user_id, row.created_at);
      }

      const eligibleUsers = userIds.filter((uid) => !recentByUser.has(uid));
      console.log(`[Goal Monitor Job] ${eligibleUsers.length}/${userIds.length} users eligible (others in cooldown)`);

      const coachRepo = new CoachRepository();
      const dashRepo = new DashboardRepository();
      let dispatched = 0;

      for (const userId of eligibleUsers) {
        const userGoals = byUser.get(userId) ?? [];
        if (userGoals.length === 0) continue;
        // Pick the most stagnant (lowest progress) to message about
        userGoals.sort((a, b) => Number(a.progress) - Number(b.progress));
        const goal = userGoals[0]!;

        try {
          const sessions = await coachRepo.sessions(userId);
          let sessionId = sessions[0]?.id;
          if (!sessionId) sessionId = (await coachRepo.createSession(userId, "Goal Recovery")).id;

          // 4. AI Evaluation
          const context = await dashRepo.getUserContextSnapshot(userId);
          const systemPrompt = `You are a proactive AI Coach for GoalPath.
          Identify goal progress blockers.
          Current User Data:
          ${JSON.stringify(context, null, 2)}
          Goal in Danger: "${goal.title}" (Current Progress: ${goal.progress}%)
          Rules:
          - Reach out to the user with empathy.
          - Mention that progress on "${goal.title}" is slow.
          - Propose adjusting the target date or resetting progress to make it easier.`;

          const userPrompt = `Write a brief proactive coaching message helping the user recover their goal "${goal.title}". Keep it under 3 sentences.`;

          let text: string | null = null;
          try {
            text = await agentChat(systemPrompt, [{ role: "user", content: userPrompt }], userId);
          } catch (aiErr: any) {
            // Don't kill the cron if LLM is unreachable / down
            console.error(`[Goal Monitor Job] AI for user ${userId} on "${goal.title}" failed (will skip):`,
              aiErr?.cause?.code ?? aiErr?.message ?? aiErr);
            continue;
          }

          await coachRepo.addMessage(userId, sessionId, "assistant", text);
          // Log intervention to enforce cooldown next hour
          await supabaseAdmin.from("ai_intervention_log").insert({
            user_id: userId,
            goal_id: goal.id,
            intervention_type: "stagnant_reminder"
          });

          dispatched++;
          console.log(`[Goal Monitor Job] [${dispatched}/${eligibleUsers.length}] Dispatched to user ${userId} on "${goal.title}"`);
        } catch (err) {
          console.error(`[Goal Monitor Job] Failed for user ${userId}:`, err);
          // continue — one user's failure shouldn't kill the loop
        }
      }

      const elapsedMs = Date.now() - tickStart;
      console.log(`[Goal Monitor Job] Done — dispatched ${dispatched} messages in ${elapsedMs}ms`);
    } catch (err) {
      console.error("[Goal Monitor Job] Error executing job:", err);
    }
  });
}
