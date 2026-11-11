import cron from "node-cron";
import { prisma } from "../db.js";
import { CoachRepository, DashboardRepository } from "../repositories.js";
import { agentChat } from "../llm-client.js";

// Tunables
const MAX_INTERVENTIONS_PER_TICK = 10;
const COOLDOWN_HOURS = 24;
const STAGNANT_MIN_AGE_DAYS = 1;

export function initGoalMonitorJob() {
  cron.schedule("0 * * * *", async () => {
    console.log("[Goal Monitor Job] Running check for stagnant goals...");
    const tickStart = Date.now();

    try {
      const now = new Date();
      const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const cooldownCutoff = new Date(now.getTime() - COOLDOWN_HOURS * 60 * 60 * 1000);
      const minStartDate = new Date(now.getTime() - STAGNANT_MIN_AGE_DAYS * 24 * 60 * 60 * 1000);

      // Fetch ALL stagnant goals in one query
      const goals = await prisma.goal.findMany({
        where: {
          start_date: { lte: minStartDate },
        },
        select: {
          id: true,
          title: true,
          user_id: true,
          progress: true,
          start_date: true,
          target_date: true,
        },
      });

      if (!goals || goals.length === 0) return;

      const stagnantGoals = goals.filter((g) => {
        const progressNum = Number(g.progress);
        const isUrgentStagnant = progressNum < 30 && g.target_date <= threeDaysLater;
        const isColdStartStagnant = progressNum === 0;
        return isUrgentStagnant || isColdStartStagnant;
      });

      if (stagnantGoals.length === 0) return;

      const queue = stagnantGoals.slice(0, MAX_INTERVENTIONS_PER_TICK);
      console.log(`[Goal Monitor Job] ${stagnantGoals.length} stagnant found — processing top ${queue.length}`);

      const byUser = new Map<string, typeof queue>();
      for (const g of queue) {
        if (!g.user_id) continue;
        const arr = byUser.get(g.user_id) ?? [];
        arr.push(g);
        byUser.set(g.user_id, arr);
      }

      const userIds: string[] = Array.from(byUser.keys());
      if (userIds.length === 0) {
        console.log("[Goal Monitor Job] No eligible users with stagnant goals.");
        return;
      }

      const recent = await prisma.aiInterventionLog.findMany({
        where: {
          user_id: { in: userIds },
          created_at: { gte: cooldownCutoff },
        },
        select: { user_id: true, created_at: true },
      });

      const recentByUser = new Map<string, Date>();
      for (const row of recent) {
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
        userGoals.sort((a, b) => Number(a.progress) - Number(b.progress));
        const goal = userGoals[0]!;

        try {
          const sessions = await coachRepo.sessions(userId);
          let sessionId = sessions[0]?.id;
          if (!sessionId) sessionId = (await coachRepo.createSession(userId, "Goal Recovery")).id;

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
            console.error(`[Goal Monitor Job] AI for user ${userId} on "${goal.title}" failed (will skip):`,
              aiErr?.cause?.code ?? aiErr?.message ?? aiErr);
            continue;
          }

          await coachRepo.addMessage(userId, sessionId, "assistant", text);
          await prisma.aiInterventionLog.create({
            data: {
              user_id: userId,
              goal_id: goal.id,
              intervention_type: "stagnant_reminder",
            },
          });

          dispatched++;
          console.log(`[Goal Monitor Job] [${dispatched}/${eligibleUsers.length}] Dispatched to user ${userId} on "${goal.title}"`);
        } catch (err) {
          console.error(`[Goal Monitor Job] Failed for user ${userId}:`, err);
        }
      }

      const elapsedMs = Date.now() - tickStart;
      console.log(`[Goal Monitor Job] Done — dispatched ${dispatched} messages in ${elapsedMs}ms`);
    } catch (err) {
      console.error("[Goal Monitor Job] Error executing job:", err);
    }
  });
}
