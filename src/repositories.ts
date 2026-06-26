import { createHash, randomUUID } from "node:crypto";
import { AppError, assertDatabaseResult } from "./errors.js";
import { config } from "./config.js";
import { supabaseAdmin } from "./supabase.js";
import type {
  PersonaArchetype,
  PersonaFeatures,
  PersonaEvidence,
  PersonaAdvice,
} from "./dto/persona.js";
import { classifyArchetype, deriveAdvice, DEFAULT_HEADLINE } from "./services/personaClassifier.js";

type Difficulty = "easy" | "medium" | "hard";

function clampPct(n: number): number { return Math.max(0, Math.min(100, Math.round(n))); }
function safeDiv(a: number, b: number): number { return b === 0 ? 0 : a / b; }

/** Days between two YYYY-MM-DD dates (b - a). Naive calendar difference. */
function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.floor((db - da) / (1000 * 60 * 60 * 24));
}

const selectGoal = "id,title,category,period,progress,start_date,target_date,reminder_enabled,notification_preference,created_at,updated_at,habits(id,title,duration,difficulty,time_range,reminder_time,active_days,priority,created_at)";
const scheduleDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const timeRangeOrder = { morning: 0, afternoon: 1, evening: 2, anytime: 3 } as const;
const XP_PER_HABIT_COMPLETION = 30;
const progressRangeDays = {
  "last-7-days": 7,
  "last-30-days": 30,
  "last-3-months": 90,
  "last-6-months": 180,
  "last-year": 365,
  custom: 30,
} as const;

function resolveProgressRangeDays(range?: string) {
  return progressRangeDays[range as keyof typeof progressRangeDays] ?? progressRangeDays["last-7-days"];
}

function buildDateWindow(days: number) {
  return Array.from({ length: days }, (_, index) => {
    const offset = days - 1 - index;
    return new Date(Date.now() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  });
}

function formatProgressDateLabel(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00`);
  if (days <= 7) {
    return date.toLocaleDateString("en-US", { weekday: "short" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isHabitScheduledOnDate(
  habit: { active_days?: string[] | null; created_at?: string; time_range?: string | null },
  dateKey: string,
  goalStartDate?: string,
) {
  const activeDays = Array.isArray(habit.active_days) ? habit.active_days : [];
  const dayKey = scheduleDays[new Date(`${dateKey}T00:00:00`).getDay()]!;
  const createdDate = String(habit.created_at ?? "").slice(0, 10);
  const startsAt = String(goalStartDate ?? "").slice(0, 10);

  if (createdDate && createdDate > dateKey) return false;
  if (startsAt && startsAt > dateKey) return false;

  return activeDays.length === 0 || activeDays.includes(dayKey);
}

function getTodaySummaryMessage(completed: number, total: number, streak: number, nextHabitTitle?: string) {
  if (total === 0) {
    return "Keep today simple. Add one small habit to start building momentum.";
  }

  if (completed === total) {
    return "Today's plan is complete. Keep the streak protected and let the pace stay realistic.";
  }

  if (completed === 0 && streak > 0) {
    return `Keep the ${streak}-day streak alive. Start with ${nextHabitTitle ?? "one small habit"} and make the first rep easy.`;
  }

  if (completed === 0) {
    return `Start with ${nextHabitTitle ?? "one small habit"} and build momentum before adding intensity.`;
  }

  const remaining = total - completed;
  return `${completed} habit${completed === 1 ? "" : "s"} done. ${remaining} more to finish today's plan.`;
}

function getTodayMotivation(completed: number, total: number, streak: number, nextHabitTitle?: string) {
  if (total === 0) {
    return {
      title: "Build today's plan",
      body: "You do not have a scheduled habit for today yet. Add one lightweight habit so Today can track real progress.",
      emphasis: "setup",
    };
  }

  if (completed === total) {
    return {
      title: "Plan protected",
      body: `All ${total} habits scheduled for today are done. Use the extra space to recover, reflect, or prepare tomorrow's first action.`,
      emphasis: "complete",
    };
  }

  if (completed === 0 && streak >= 7) {
    return {
      title: "Protect the streak",
      body: `You already built a ${streak}-day streak. Do ${nextHabitTitle ?? "the easiest habit"} first and keep today's win small but certain.`,
      emphasis: "streak",
    };
  }

  if (completed === 0) {
    return {
      title: "Start light",
      body: `Open with ${nextHabitTitle ?? "your easiest habit"} and aim for completion, not intensity. Momentum matters more than volume right now.`,
      emphasis: "start",
    };
  }

  return {
    title: "Momentum is building",
    body: `${completed} of ${total} habits are already done. Finish ${nextHabitTitle ?? "the next habit"} to keep today's plan realistic and complete.`,
    emphasis: "momentum",
  };
}

export class GoalRepository {
  async list(userId: string) {
    const result = await supabaseAdmin.from("goals").select(selectGoal).eq("user_id", userId).order("created_at", { ascending: false });
    assertDatabaseResult(result.error); return result.data ?? [];
  }
  async find(userId: string, id: string) {
    const result = await supabaseAdmin.from("goals").select(selectGoal).eq("user_id", userId).eq("id", id).maybeSingle();
    assertDatabaseResult(result.error); if (!result.data) throw new AppError("Goal not found.", 404); return result.data;
  }
  async create(userId: string, input: any) {
    const { selectedHabits, selectedMilestones, ...goal } = input;
    const result = await supabaseAdmin.from("goals").insert({ user_id:userId,title:goal.title,category:goal.category,period:goal.period,progress:goal.progress,start_date:goal.startDate,target_date:goal.targetDate,reminder_enabled:goal.reminderEnabled,notification_preference:goal.notificationPreference }).select("id").single();
    assertDatabaseResult(result.error);
    const goalId = result.data!.id;
    const habits = selectedHabits.map((habit: any) => ({ goal_id:goalId,user_id:userId,title:habit.title,duration:habit.duration,difficulty:habit.difficulty,time_range:habit.schedule.timeRange,reminder_time:habit.schedule.reminderTime||null,active_days:habit.schedule.activeDays,priority:habit.schedule.priority }));
    const habitResult = await supabaseAdmin.from("habits").insert(habits);
    if (habitResult.error) {
      await supabaseAdmin.from("goals").delete().eq("id", goalId).eq("user_id", userId);
      assertDatabaseResult(habitResult.error);
    }
    if (selectedMilestones && selectedMilestones.length > 0) {
      const milestoneRows = selectedMilestones.map((m: any, idx: number) => ({
        user_id: userId, goal_id: goalId,
        title: (m.title ?? "").toString().trim(),
        target_date: m.target_date ?? null,
        sort_order: typeof m.sort_order === "number" ? m.sort_order : idx,
      }));
      await supabaseAdmin.from("goal_milestones").insert(milestoneRows);
    }
    return this.find(userId, goalId);
  }
  async update(userId: string, id: string, input: any) {
    await this.find(userId, id);
    const payload: Record<string, unknown> = {}; const map: Record<string,string> = {title:"title",category:"category",period:"period",progress:"progress",startDate:"start_date",targetDate:"target_date",reminderEnabled:"reminder_enabled",notificationPreference:"notification_preference"};
    for (const [key,column] of Object.entries(map)) if (input[key] !== undefined) payload[column] = input[key];
    payload.updated_at = new Date().toISOString();
    const result = await supabaseAdmin.from("goals").update(payload).eq("user_id", userId).eq("id", id); assertDatabaseResult(result.error);
    return this.find(userId, id);
  }
  async remove(userId: string, id: string) { await this.find(userId,id); const result = await supabaseAdmin.from("goals").delete().eq("user_id", userId).eq("id", id); assertDatabaseResult(result.error); }

  async dashboard(userId: string) {
    const goals = await this.list(userId);
    const performance = await new DashboardRepository().getGoalPerformance(userId);
    const performanceMap = new Map(performance.map((item: any) => [item.id, item]));
    const goalIds = goals.map((goal: any) => goal.id);

    const milestonesResult = goalIds.length === 0
      ? { data: [] as any[], error: null }
      : await supabaseAdmin
          .from("goal_milestones")
          .select("id, goal_id, completed_at")
          .eq("user_id", userId)
          .in("goal_id", goalIds);
    assertDatabaseResult(milestonesResult.error);

    const milestonesByGoal = new Map<string, { total: number; completed: number }>();
    for (const milestone of milestonesResult.data ?? []) {
      const current = milestonesByGoal.get((milestone as any).goal_id) ?? { total: 0, completed: 0 };
      current.total += 1;
      if ((milestone as any).completed_at) current.completed += 1;
      milestonesByGoal.set((milestone as any).goal_id, current);
    }

    const enrichedGoals = goals.map((goal: any) => {
      const totalMinutes = (goal.habits ?? []).reduce((sum: number, habit: any) => sum + Number(habit.duration ?? 0), 0);
      const milestoneInfo = milestonesByGoal.get(goal.id) ?? { total: 0, completed: 0 };
      const perf = performanceMap.get(goal.id);
      return {
        ...goal,
        totalMinutes,
        status: perf?.status ?? "On Track",
        daysLeft: perf?.daysLeft ?? null,
        milestoneCount: milestoneInfo.total,
        completedMilestoneCount: milestoneInfo.completed,
      };
    });

    const totalHabits = enrichedGoals.reduce((sum: number, goal: any) => sum + (goal.habits?.length ?? 0), 0);
    const totalMinutes = enrichedGoals.reduce((sum: number, goal: any) => sum + goal.totalMinutes, 0);
    const averageProgress = enrichedGoals.length
      ? Math.round(enrichedGoals.reduce((sum: number, goal: any) => sum + Number(goal.progress ?? 0), 0) / enrichedGoals.length)
      : 0;
    const strongestGoal = enrichedGoals.reduce<any | null>(
      (best, goal) => (!best || Number(goal.progress ?? 0) > Number(best.progress ?? 0) ? goal : best),
      null,
    );
    const atRiskGoals = enrichedGoals.filter((goal: any) => goal.status === "At Risk" || goal.status === "Behind Schedule").length;
    const completedMilestones = enrichedGoals.reduce((sum: number, goal: any) => sum + goal.completedMilestoneCount, 0);

    return {
      summary: {
        activeGoals: enrichedGoals.length,
        totalHabits,
        totalMinutes,
        averageProgress,
        atRiskGoals,
        completedMilestones,
      },
      strongestGoal,
      goals: enrichedGoals,
    };
  }
}

export class UserRepository {
  async profile(userId:string) {
    const result = await supabaseAdmin.from("profiles").select("*").eq("id", userId).maybeSingle();
    assertDatabaseResult(result.error);

    if (result.data) return result.data;

    const fallback = await supabaseAdmin.auth.admin.getUserById(userId);
    if (fallback.error) throw new AppError("Profile not found.", 404);

    const metadata = fallback.data.user?.user_metadata ?? {};
    const email = fallback.data.user?.email ?? "";
    const name = String(metadata.name ?? email.split("@")[0] ?? "GoalPath User").trim() || "GoalPath User";
    const usernameBase = String(metadata.username ?? email.split("@")[0] ?? "goalpath").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "");
    const username = usernameBase ? `@${usernameBase}` : "@goalpath";

    const insertResult = await supabaseAdmin
      .from("profiles")
      .insert({
        id: userId,
        name,
        username,
        avatar_url: metadata.avatar_url ?? null,
        xp: 0,
        streak_days: 0,
        level: 1,
      })
      .select("*")
      .single();
    assertDatabaseResult(insertResult.error);
    return insertResult.data;
  }
  async updateProfile(userId:string,input:any) { const result=await supabaseAdmin.from("profiles").update({...(input.name!==undefined&&{name:input.name}),...(input.username!==undefined&&{username:input.username}),...(input.avatarUrl!==undefined&&{avatar_url:input.avatarUrl}),updated_at:new Date().toISOString()}).eq("id",userId).select("*").single(); assertDatabaseResult(result.error); return result.data; }
  async preferences(userId:string) {
    const result = await supabaseAdmin.from("user_preferences").select("*").eq("user_id", userId).maybeSingle();
    assertDatabaseResult(result.error);
    if (result.data) return result.data;

    return {
      user_id: userId,
      appearance: "light",
      notifications: [
        { id: "daily-habit", title: "Daily Habit Reminders", enabled: true, description: "Stay on track with daily check-ins." },
        { id: "progress-updates", title: "Goal Progress Updates", enabled: true, description: "Get updates when goals move forward." },
        { id: "achievement-alerts", title: "Achievement Notifications", enabled: true, description: "Celebrate every badge you unlock." },
        { id: "ai-coach", title: "AI Coach Suggestions", enabled: false, description: "Receive smart prompts from your coach." },
        { id: "weekly-reports", title: "Weekly Reports", enabled: true, description: "Review your performance every week." },
      ],
    };
  }
  async updatePreferences(userId:string,input:any) { const result=await supabaseAdmin.from("user_preferences").upsert({user_id:userId,...(input.appearance!==undefined&&{appearance:input.appearance}),...(input.notifications!==undefined&&{notifications:input.notifications}),updated_at:new Date().toISOString()}).select("*").single(); assertDatabaseResult(result.error); return result.data; }
  createAvatarUploadSignature(userId: string) {
    if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
      throw new AppError("Cloudinary upload is not configured on the server.", 503);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `${config.cloudinaryUploadFolder.replace(/\/+$/, "")}/${userId}`;
    const publicId = `avatar-${timestamp}-${randomUUID().slice(0, 8)}`;
    const params = {
      folder,
      public_id: publicId,
      timestamp,
    };
    const stringToSign = Object.entries(params)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    const signature = createHash("sha1")
      .update(`${stringToSign}${config.cloudinaryApiSecret}`)
      .digest("hex");

    return {
      cloudName: config.cloudinaryCloudName,
      apiKey: config.cloudinaryApiKey,
      timestamp,
      signature,
      folder,
      publicId,
      uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/upload`,
    };
  }
  async overview(userId: string) {
    const [profile, preferences, goalDashboard, progress] = await Promise.all([
      this.profile(userId),
      this.preferences(userId),
      new GoalRepository().dashboard(userId),
      new DashboardRepository().getProgressDash(userId),
    ]);

    const unreadNotificationsResult = await supabaseAdmin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null);
    assertDatabaseResult(unreadNotificationsResult.error);

    return {
      profile,
      preferences,
      stats: {
        activeGoals: goalDashboard.summary.activeGoals,
        currentStreak: progress.currentStreak,
        completionRate: progress.completionRate,
        completedMilestones: goalDashboard.summary.completedMilestones,
        totalXp: Number(progress.totalXp ?? profile?.xp ?? 0),
      },
      summary: {
        totalHabits: goalDashboard.summary.totalHabits,
        totalMinutes: goalDashboard.summary.totalMinutes,
        averageProgress: goalDashboard.summary.averageProgress,
        atRiskGoals: goalDashboard.summary.atRiskGoals,
        unreadNotifications: unreadNotificationsResult.count ?? 0,
      },
    };
  }
}

export class DashboardRepository {
  /** Recompute goal.progress in-app from habit_completions.
   *  Formula: (completed_count since start_date) / (habits_count * days_since_start) * 100
   *  Idempotent — safe to call after every completion change.
   */
  async recomputeGoalProgress(userId: string, goalId: string): Promise<number> {
    const { data: goal, error: gErr } = await supabaseAdmin
      .from("goals")
      .select("id, start_date")
      .eq("user_id", userId)
      .eq("id", goalId)
      .maybeSingle();
    assertDatabaseResult(gErr);
    if (!goal) return 0;

    const { count: habitsCount, error: hErr } = await supabaseAdmin
      .from("habits")
      .select("id", { count: "exact", head: true })
      .eq("goal_id", goalId);
    assertDatabaseResult(hErr);

    const habitCount = habitsCount ?? 0;
    if (habitCount === 0) {
      await supabaseAdmin.from("goals").update({ progress: 0, updated_at: new Date().toISOString() }).eq("id", goalId);
      return 0;
    }

    const startDay = goal.start_date.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const eligibleDays = Math.max(1, daysBetween(startDay, today) + 1);

    const { count: doneCount, error: cErr } = await supabaseAdmin
      .from("habit_completions")
      .select("id", { count: "exact", head: true })
      .eq("completed", true)
      .gte("completion_date", startDay)
      .lte("completion_date", today)
      .in("habit_id", (await supabaseAdmin.from("habits").select("id").eq("goal_id", goalId)).data?.map((h: any) => h.id) ?? ["00000000-0000-0000-0000-000000000000"]);
    assertDatabaseResult(cErr);

    const expected = habitCount * eligibleDays;
    const newProgress = Math.min(100, Number(((doneCount ?? 0) / expected * 100).toFixed(2)));

    await supabaseAdmin
      .from("goals")
      .update({ progress: newProgress, updated_at: new Date().toISOString() })
      .eq("id", goalId);

    return newProgress;
  }

  /** Compute progress-style stats for the progress page (current_goals_count, completed_habits_7d, etc.).
   *  Replaces hardcoded mock expectations on the frontend.
   */
  async getProgressDash(userId: string) {
    // habits total completed last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { count: completedLast7 } = await supabaseAdmin
      .from("habit_completions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("completed", true)
      .gte("completion_date", sevenDaysAgo);
    const { count: missedLast7 } = await supabaseAdmin
      .from("habit_completions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("completed", false)
      .gte("completion_date", sevenDaysAgo);
    const { count: totalCompletions } = await supabaseAdmin
      .from("habit_completions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("completed", true);
    const { data: goals } = await supabaseAdmin
      .from("goals")
      .select("id, progress")
      .eq("user_id", userId);
    const activeGoals = goals?.length ?? 0;
    // Naive streak: distinct dates with completed=true going back from today
    const { data: streakRows } = await supabaseAdmin
      .from("habit_completions")
      .select("completion_date")
      .eq("user_id", userId)
      .eq("completed", true)
      .order("completion_date", { ascending: false })
      .limit(60);
    let streak = 0;
    if (streakRows && streakRows.length > 0) {
      const dates = new Set<string>((streakRows as any[]).map(r => r.completion_date));
      for (let i = 0; ; i++) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        if (dates.has(d)) streak++;
        else break;
        if (streak > 60) break;
      }
    }
    const totalXp = (totalCompletions ?? 0) * 30; // simple XP model: 30 XP per completion
    const completionRate = ((completedLast7 ?? 0) + (missedLast7 ?? 0)) > 0
      ? Math.round(((completedLast7 ?? 0) / ((completedLast7 ?? 0) + (missedLast7 ?? 0))) * 100)
      : 0;
    const profile = await supabaseAdmin.from("profiles").select("xp, streak_days, level").eq("id", userId).maybeSingle();
    return {
      activeGoals,
      habitsCompleted7d: completedLast7 ?? 0,
      habitsMissed7d: missedLast7 ?? 0,
      totalCompletions: totalCompletions ?? 0,
      currentStreak: streak,
      totalXp,
      completionRate,
      profile: profile?.data ?? { xp: totalXp, streak_days: streak, level: 1 },
    };
  }

  async getProgressOverview(userId: string, range: string) {
    const windowDays = resolveProgressRangeDays(range);
    const dateWindow = buildDateWindow(windowDays);
    const startDate = dateWindow[0]!;
    const endDate = dateWindow[dateWindow.length - 1]!;

    const [stats, goals, goalPerformance, profileResult, completionsResult, milestonesResult] = await Promise.all([
      this.getProgressDash(userId),
      new GoalRepository().list(userId),
      this.getGoalPerformance(userId),
      supabaseAdmin.from("profiles").select("xp, streak_days, level").eq("id", userId).maybeSingle(),
      supabaseAdmin
        .from("habit_completions")
        .select("habit_id, completion_date, completed")
        .eq("user_id", userId)
        .gte("completion_date", startDate)
        .lte("completion_date", endDate),
      supabaseAdmin
        .from("goal_milestones")
        .select("id, goal_id, completed_at")
        .eq("user_id", userId),
    ]);

    assertDatabaseResult(profileResult.error);
    assertDatabaseResult(completionsResult.error);
    assertDatabaseResult(milestonesResult.error);

    const completionMap = new Map<string, boolean>();
    for (const row of completionsResult.data ?? []) {
      completionMap.set(`${(row as any).habit_id}:${(row as any).completion_date}`, Boolean((row as any).completed));
    }

    const habits = goals.flatMap((goal: any) =>
      (goal.habits ?? []).map((habit: any) => ({
        ...habit,
        goal_id: goal.id,
        goal_title: goal.title,
        goal_start_date: goal.start_date,
      })),
    );

    const dayStats = dateWindow.map((dateKey) => {
      const scheduledHabits = habits.filter((habit: any) =>
        isHabitScheduledOnDate(habit, dateKey, habit.goal_start_date),
      );
      const completedHabits = scheduledHabits.filter(
        (habit: any) => completionMap.get(`${habit.id}:${dateKey}`) === true,
      );
      const rate = scheduledHabits.length ? clampPct((completedHabits.length / scheduledHabits.length) * 100) : 0;

      return {
        date: dateKey,
        label: formatProgressDateLabel(dateKey, windowDays),
        scheduled: scheduledHabits.length,
        completed: completedHabits.length,
        completionRate: rate,
      };
    });

    const habitPerformance = habits
      .map((habit: any) => {
        const scheduledDates = dateWindow.filter((dateKey) =>
          isHabitScheduledOnDate(habit, dateKey, habit.goal_start_date),
        );
        const completedCount = scheduledDates.filter(
          (dateKey) => completionMap.get(`${habit.id}:${dateKey}`) === true,
        ).length;
        const expectedCount = scheduledDates.length;
        const midpoint = Math.floor(scheduledDates.length / 2);
        const firstHalf = scheduledDates.slice(0, midpoint);
        const secondHalf = scheduledDates.slice(midpoint);
        const firstHalfRate = firstHalf.length
          ? firstHalf.filter((dateKey) => completionMap.get(`${habit.id}:${dateKey}`) === true).length / firstHalf.length
          : 0;
        const secondHalfRate = secondHalf.length
          ? secondHalf.filter((dateKey) => completionMap.get(`${habit.id}:${dateKey}`) === true).length / secondHalf.length
          : 0;

        return {
          id: habit.id,
          title: habit.title,
          completionRate: expectedCount ? clampPct((completedCount / expectedCount) * 100) : 0,
          trend: secondHalfRate > firstHalfRate ? "up" : secondHalfRate < firstHalfRate ? "down" : "flat",
          totalCompletions: completedCount,
          timeRange: habit.time_range ?? "anytime",
        };
      })
      .filter((habit) => habit.totalCompletions > 0 || habit.completionRate > 0)
      .sort((a, b) => b.completionRate - a.completionRate || b.totalCompletions - a.totalCompletions)
      .slice(0, 5);

    const heatmap = dayStats.slice(-35).map((day) => ({
      date: day.date,
      level:
        day.scheduled === 0
          ? "none"
          : day.completionRate >= 80
            ? "high"
            : day.completionRate >= 50
              ? "medium"
              : day.completed > 0
                ? "low"
                : "none",
    }));

    const completedGoals = goalPerformance.filter((goal: any) => goal.status === "Completed").length;
    const atRiskGoals = goalPerformance.filter((goal: any) => goal.status === "At Risk" || goal.status === "Behind Schedule").length;
    const completedMilestones = (milestonesResult.data ?? []).filter((row: any) => row.completed_at).length;
    const totalMilestones = (milestonesResult.data ?? []).length;
    const totalScheduled = dayStats.reduce((sum, day) => sum + day.scheduled, 0);
    const totalCompletedInRange = dayStats.reduce((sum, day) => sum + day.completed, 0);
    const completionRate = totalScheduled ? clampPct((totalCompletedInRange / totalScheduled) * 100) : 0;

    const achievements = [
      {
        id: "first-habit",
        title: "First Habit Completed",
        subtitle: stats.totalCompletions > 0 ? "At least one habit has been completed." : "Complete one habit to unlock this badge.",
        emoji: "🏆",
        unlocked: stats.totalCompletions > 0,
      },
      {
        id: "streak-7",
        title: "7 Day Streak",
        subtitle: stats.currentStreak >= 7 ? `Current streak is ${stats.currentStreak} days.` : "Reach a 7-day streak to unlock this badge.",
        emoji: "🔥",
        unlocked: stats.currentStreak >= 7,
      },
      {
        id: "consistency-30",
        title: "30 Day Consistency",
        subtitle: stats.currentStreak >= 30 ? "A 30-day streak has already been reached." : "Keep the streak alive until it reaches 30 days.",
        emoji: "⭐",
        unlocked: stats.currentStreak >= 30,
      },
      {
        id: "goal-achiever",
        title: "Goal Achiever",
        subtitle: completedGoals > 0 ? `${completedGoals} goal${completedGoals > 1 ? "s are" : " is"} already complete.` : "Finish one goal to unlock this badge.",
        emoji: "🎯",
        unlocked: completedGoals > 0,
      },
    ];

    const timeRangeStats = habits.reduce<Record<string, { expected: number; completed: number }>>((acc, habit: any) => {
      const scheduledDates = dateWindow.filter((dateKey) =>
        isHabitScheduledOnDate(habit, dateKey, habit.goal_start_date),
      );
      const completedCount = scheduledDates.filter(
        (dateKey) => completionMap.get(`${habit.id}:${dateKey}`) === true,
      ).length;
      const key = habit.time_range ?? "anytime";
      const current = acc[key] ?? { expected: 0, completed: 0 };
      current.expected += scheduledDates.length;
      current.completed += completedCount;
      acc[key] = current;
      return acc;
    }, {});

    const bestTimeRange = Object.entries(timeRangeStats)
      .map(([slot, values]) => ({
        slot,
        rate: values.expected ? clampPct((values.completed / values.expected) * 100) : 0,
      }))
      .sort((a, b) => b.rate - a.rate)[0];

    const strongestHabit = habitPerformance[0];
    const insights = [
      {
        id: "consistency-summary",
        message: totalScheduled > 0 ? `${totalCompletedInRange} of ${totalScheduled} scheduled habits were completed in this range.` : "There is no scheduled habit activity in the selected range yet.",
        accent: "blue",
      },
      {
        id: "best-time-range",
        message: bestTimeRange && bestTimeRange.rate > 0 ? `${bestTimeRange.slot.charAt(0).toUpperCase() + bestTimeRange.slot.slice(1)} is currently your strongest time slot at ${bestTimeRange.rate}%.` : "No time-of-day pattern is strong enough yet. Keep logging completions to reveal one.",
        accent: "gold",
      },
      {
        id: "risk-or-strength",
        message: atRiskGoals > 0 ? `${atRiskGoals} goal${atRiskGoals > 1 ? "s are" : " is"} behind pace. Reduce scope or finish the easiest habit first.` : strongestHabit ? `"${strongestHabit.title}" is your most reliable habit right now at ${strongestHabit.completionRate}%.` : "Complete a few habits and this space will start surfacing actionable patterns.",
        accent: atRiskGoals > 0 ? "coral" : "lavender",
      },
    ];

    return {
      range,
      windowDays,
      summary: {
        activeGoals: goals.length,
        currentStreak: stats.currentStreak,
        totalXp: Number(stats.totalXp ?? profileResult.data?.xp ?? 0),
        completionRate,
        habitsCompleted: totalCompletedInRange,
        habitsMissed: Math.max(totalScheduled - totalCompletedInRange, 0),
        completedGoals,
        atRiskGoals,
        totalMilestones,
        completedMilestones,
      },
      goals: goalPerformance,
      consistencySeries: dayStats.map((day) => ({
        date: day.label,
        completionRate: day.completionRate,
        habitsCompleted: day.completed,
      })),
      habitPerformance,
      heatmap,
      achievements,
      insights,
    };
  }

  /** Per-goal real performance numbers — built off goals.progress (now auto-recomputed). */
  async getGoalPerformance(userId: string) {
    const { data: goals } = await supabaseAdmin
      .from("goals")
      .select("id, title, target_date, progress, start_date")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (!goals) return [];
    const today = Date.now();
    return (goals as any[]).map((g, idx) => {
      const target = new Date(g.target_date).getTime();
      const daysLeft = Math.floor((target - today) / (1000 * 60 * 60 * 24));
      const pace = g.progress >= 100 ? "Completed"
                  : daysLeft < 7 ? "At Risk"
                  : g.progress >= 50 ? "On Track"
                  : "Behind Schedule";
      return {
        id: g.id,
        title: g.title,
        progress: Number(g.progress),
        targetDate: g.target_date,
        status: pace,
        color: "bg-primary",
        daysLeft,
      };
    });
  }

  async setCompletion(userId: string, habitId: string, completed: boolean, completionDate?: string) {
    const habit = await supabaseAdmin.from("habits").select("id, goal_id").eq("id", habitId).eq("user_id", userId).maybeSingle();
    assertDatabaseResult(habit.error);
    if (!habit.data) throw new AppError("Habit not found.", 404);
    const targetDate = completionDate ?? new Date().toISOString().slice(0, 10);
    const existing = await supabaseAdmin
      .from("habit_completions")
      .select("id, completed")
      .eq("habit_id", habitId)
      .eq("user_id", userId)
      .eq("completion_date", targetDate)
      .maybeSingle();
    assertDatabaseResult(existing.error);

    const wasCompleted = Boolean(existing.data?.completed);
    const xpDelta = completed === wasCompleted ? 0 : completed ? XP_PER_HABIT_COMPLETION : -XP_PER_HABIT_COMPLETION;
    let completionResult: Record<string, unknown>;

    if (completed) {
      const result = await supabaseAdmin.from("habit_completions").upsert({
        habit_id: habitId,
        user_id: userId,
        completion_date: targetDate,
        completed: true,
        completed_at: new Date().toISOString(),
      }, { onConflict: "habit_id,completion_date" }).select("*").single();
      assertDatabaseResult(result.error);
      completionResult = result.data;
    } else {
      const result = await supabaseAdmin
        .from("habit_completions")
        .delete()
        .eq("habit_id", habitId)
        .eq("user_id", userId)
        .eq("completion_date", targetDate);
      assertDatabaseResult(result.error);
      completionResult = { habit_id: habitId, completion_date: targetDate, completed: false };
    }

    if (xpDelta !== 0) {
      const totalCompletedResult = await supabaseAdmin
        .from("habit_completions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("completed", true);
      assertDatabaseResult(totalCompletedResult.error);

      const nextXp = Math.max(0, Number(totalCompletedResult.count ?? 0) * XP_PER_HABIT_COMPLETION);
      const updateProfileResult = await supabaseAdmin
        .from("profiles")
        .update({ xp: nextXp, updated_at: new Date().toISOString() })
        .eq("id", userId);
      assertDatabaseResult(updateProfileResult.error);

      completionResult.xp_delta = xpDelta;
      completionResult.total_xp = nextXp;
    } else {
      completionResult.xp_delta = 0;
    }

    // Auto-recompute parent goal.progress (also fires SQL trigger on deployed env)
    if (habit.data.goal_id) {
      try {
        await this.recomputeGoalProgress(userId, habit.data.goal_id);
      } catch (e) {
        console.error("[Dashboard] recompute fallback failed:", (e as Error).message);
        // Non-fatal — completion saved successfully
      }
    }

    return completionResult;
  }

  async today(userId: string) {
    const goals = await new GoalRepository().list(userId);
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = scheduleDays[new Date(`${today}T00:00:00`).getDay()]!;

    const completions = await supabaseAdmin
      .from("habit_completions")
      .select("habit_id,completed")
      .eq("user_id", userId)
      .eq("completion_date", today);
    assertDatabaseResult(completions.error);

    const profileResult = await supabaseAdmin
      .from("profiles")
      .select("name, username, avatar_url, xp, streak_days, level")
      .eq("id", userId)
      .maybeSingle();
    assertDatabaseResult(profileResult.error);

    const stats = await this.getProgressDash(userId);
    const completionMap = new Map<string, boolean>(
      (completions.data ?? []).map((row: any) => [row.habit_id, row.completed]),
    );

    const habits = goals
      .flatMap((goal: any) =>
        (goal.habits ?? [])
          .filter((habit: any) => {
            const activeDays = Array.isArray(habit.active_days) ? habit.active_days : [];
            return activeDays.length === 0 || activeDays.includes(dayKey);
          })
          .map((habit: any) => ({
            id: habit.id,
            title: habit.title,
            duration: habit.duration,
            difficulty: habit.difficulty,
            schedule: {
              timeRange: habit.time_range,
              reminderTime: habit.reminder_time ?? undefined,
              activeDays: Array.isArray(habit.active_days) ? habit.active_days : [],
              priority: habit.priority,
            },
            createdAt: habit.created_at,
            goalId: goal.id,
            goalTitle: goal.title,
            completed: completionMap.get(habit.id) ?? false,
          })),
      )
      .sort((a: any, b: any) => {
        const timeOrder = timeRangeOrder[a.schedule.timeRange as keyof typeof timeRangeOrder] - timeRangeOrder[b.schedule.timeRange as keyof typeof timeRangeOrder];
        if (timeOrder !== 0) return timeOrder;
        return a.title.localeCompare(b.title);
      });

    const goalsWithToday = goals.map((goal: any) => {
      const todayHabits = habits.filter((habit: any) => habit.goalId === goal.id);
      const todayCompletedHabits = todayHabits.filter((habit: any) => habit.completed).length;
      return {
        ...goal,
        todayTotalHabits: todayHabits.length,
        todayCompletedHabits,
      };
    });

    const completedHabits = habits.filter((habit: any) => habit.completed).length;
    const totalHabits = habits.length;
    const completionRate = totalHabits > 0 ? Math.round((completedHabits / totalHabits) * 100) : 0;
    const currentStreak = Number(stats.currentStreak ?? profileResult.data?.streak_days ?? 0);
    const totalXp = Number(stats.totalXp ?? profileResult.data?.xp ?? 0);
    const level = Number(profileResult.data?.level ?? stats.profile?.level ?? 1);
    const focusQueue = habits.filter((habit: any) => !habit.completed).slice(0, 3);
    const nextHabitTitle = focusQueue[0]?.title;

    return {
      date: today,
      profile: {
        name: profileResult.data?.name ?? null,
        username: profileResult.data?.username ?? null,
        avatar_url: profileResult.data?.avatar_url ?? null,
        xp: totalXp,
        streak_days: currentStreak,
        level,
      },
      summary: {
        activeGoals: goals.length,
        totalHabits,
        completedHabits,
        completionRate,
        currentStreak,
        totalXp,
        level,
        habitsCompleted7d: stats.habitsCompleted7d ?? 0,
        habitsMissed7d: stats.habitsMissed7d ?? 0,
        message: getTodaySummaryMessage(completedHabits, totalHabits, currentStreak, nextHabitTitle),
      },
      goals: goalsWithToday,
      habits,
      focusQueue,
      motivation: getTodayMotivation(completedHabits, totalHabits, currentStreak, nextHabitTitle),
    };
  }

  async getUserContextSnapshot(userId: string) {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 1. Get basic profile
    const profileResult = await supabaseAdmin.from("profiles")
      .select("level, xp, streak_days")
      .eq("id", userId)
      .single();
    
    // 2. Get active goals
    const goalsResult = await supabaseAdmin.from("goals")
      .select("id, title, category, progress")
      .eq("user_id", userId);

    // 3. Get habit completions for the last 7 days
    const completionsResult = await supabaseAdmin.from("habit_completions")
      .select("completed")
      .eq("user_id", userId)
      .gte("completion_date", sevenDaysAgo);

    const profile = profileResult.data || { level: 1, xp: 0, streak_days: 0 };
    const active_goals = goalsResult.data || [];
    const completions = completionsResult.data || [];

    const completed_count = completions.filter(c => c.completed).length;
    const missed_count = completions.length - completed_count;

    return {
      profile,
      active_goals_count: active_goals.length,
      active_goals,
      performance_last_7_days: {
        completed_habits: completed_count,
        missed_habits: missed_count
      }
    };
  }
}

type NotificationInput = {
  type: "habit_reminder" | "missed_habit" | "streak" | "coach_tip" | "progress_update" | "goal_risk";
  title: string;
  message: string;
  source_key: string;
  notification_date: string;
  metadata?: Record<string, unknown>;
};

const notificationDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isHabitScheduled(habit: any, day: string) {
  const activeDays = Array.isArray(habit.active_days) ? habit.active_days : [];
  return activeDays.length === 0 || activeDays.includes(day);
}

function shouldNotifyHabit(goal: any, habit: any) {
  if (!goal.reminder_enabled || goal.notification_preference === "none") return false;
  return goal.notification_preference === "all" || habit.priority === "high";
}

function timeRangeLabel(timeRange: string) {
  if (timeRange === "morning") return "morning";
  if (timeRange === "afternoon") return "afternoon";
  if (timeRange === "evening") return "evening";
  return "scheduled";
}

export class NotificationRepository {
  private async upsertGenerated(userId: string, rows: NotificationInput[]) {
    if (rows.length === 0) return;
    const result = await supabaseAdmin
      .from("notifications")
      .upsert(
        rows.map((row) => ({
          user_id: userId,
          ...row,
          metadata: row.metadata ?? {},
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "user_id,type,source_key,notification_date", ignoreDuplicates: true },
      );
    assertDatabaseResult(result.error);
  }

  private async generateFlowNotifications(userId: string) {
    const now = new Date();
    const today = dateKey(now);
    const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterday = dateKey(yesterdayDate);
    const todayDay = notificationDays[now.getDay()]!;
    const yesterdayDay = notificationDays[yesterdayDate.getDay()]!;

    const { data: goals, error: goalsError } = await supabaseAdmin
      .from("goals")
      .select("id,title,progress,target_date,reminder_enabled,notification_preference,updated_at,habits(id,title,duration,time_range,active_days,priority)")
      .eq("user_id", userId)
      .neq("notification_preference", "none")
      .order("updated_at", { ascending: false });
    assertDatabaseResult(goalsError);

    const { data: todayCompletions, error: todayError } = await supabaseAdmin
      .from("habit_completions")
      .select("habit_id,completed")
      .eq("user_id", userId)
      .eq("completion_date", today);
    assertDatabaseResult(todayError);

    const { data: yesterdayCompletions, error: yesterdayError } = await supabaseAdmin
      .from("habit_completions")
      .select("habit_id,completed")
      .eq("user_id", userId)
      .eq("completion_date", yesterday);
    assertDatabaseResult(yesterdayError);

    const todayDone = new Map((todayCompletions ?? []).map((row: any) => [row.habit_id, row.completed]));
    const yesterdayDone = new Map((yesterdayCompletions ?? []).map((row: any) => [row.habit_id, row.completed]));
    const generated: NotificationInput[] = [];
    const pendingToday: any[] = [];

    for (const goal of goals ?? []) {
      const habits = Array.isArray((goal as any).habits) ? (goal as any).habits : [];
      for (const habit of habits) {
        if (!shouldNotifyHabit(goal, habit)) continue;

        if (isHabitScheduled(habit, todayDay) && todayDone.get(habit.id) !== true) {
          pendingToday.push({ goal, habit });
        }

        if (isHabitScheduled(habit, yesterdayDay) && yesterdayDone.get(habit.id) !== true) {
          generated.push({
            type: "missed_habit",
            title: `Missed: ${habit.title}`,
            message: `You skipped this ${timeRangeLabel(habit.time_range)} habit yesterday. Restart with a smaller version today.`,
            source_key: `habit:${habit.id}:missed`,
            notification_date: today,
            metadata: { habitId: habit.id, goalId: goal.id },
          });
        }
      }

      const progress = Number((goal as any).progress) || 0;
      const targetDate = new Date((goal as any).target_date);
      const daysLeft = Math.ceil((targetDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

      if (Number.isFinite(daysLeft) && daysLeft >= 0 && daysLeft <= 7 && progress < 70) {
        generated.push({
          type: "goal_risk",
          title: `${(goal as any).title} needs attention`,
          message: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left and progress is ${Math.round(progress)}%. Consider adjusting the plan or finishing one key habit today.`,
          source_key: `goal:${(goal as any).id}:risk`,
          notification_date: today,
          metadata: { goalId: (goal as any).id, progress, daysLeft },
        });
      }

      if (String((goal as any).updated_at ?? "").slice(0, 10) === today && progress > 0) {
        generated.push({
          type: "progress_update",
          title: "Progress Update",
          message: `${(goal as any).title} is now at ${Math.round(progress)}%. Keep the next action realistic.`,
          source_key: `goal:${(goal as any).id}:progress`,
          notification_date: today,
          metadata: { goalId: (goal as any).id, progress },
        });
      }
    }

    for (const item of pendingToday.slice(0, 4)) {
      generated.push({
        type: "habit_reminder",
        title: item.habit.title,
        message: `Your ${timeRangeLabel(item.habit.time_range)} habit is waiting. Keep it light and finish one small action.`,
        source_key: `habit:${item.habit.id}:today`,
        notification_date: today,
        metadata: { habitId: item.habit.id, goalId: item.goal.id },
      });
    }

    if (pendingToday.length > 0) {
      generated.push({
        type: "coach_tip",
        title: "AI Coach Tip",
        message: `Start with "${pendingToday[0]!.habit.title}". If energy is low, do the 2-minute version first.`,
        source_key: "coach-tip:pending-habit",
        notification_date: today,
        metadata: { habitId: pendingToday[0]!.habit.id },
      });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("streak_days")
      .eq("id", userId)
      .maybeSingle();
    assertDatabaseResult(profileError);

    const streak = Number(profile?.streak_days ?? 0);
    if (streak >= 7) {
      generated.push({
        type: "streak",
        title: `${streak} Day Streak`,
        message: "You protected your streak. Keep the momentum with one small habit today.",
        source_key: `streak:${streak}`,
        notification_date: today,
        metadata: { streak },
      });
    }

    await this.upsertGenerated(userId, generated);
  }

  async list(userId: string) {
    await this.generateFlowNotifications(userId);

    const result = await supabaseAdmin
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);
    assertDatabaseResult(result.error);

    return result.data ?? [];
  }

  async markAllRead(userId: string) {
    const result = await supabaseAdmin
      .from("notifications")
      .update({ read_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("read_at", null)
      .select("*");
    assertDatabaseResult(result.error);
    return result.data ?? [];
  }
}

export class CoachRepository {
  private async assertSessionOwner(userId: string, sessionId: string) {
    const result = await supabaseAdmin.from("coach_sessions").select("id").eq("id", sessionId).eq("user_id", userId).maybeSingle();
    assertDatabaseResult(result.error);
    if (!result.data) throw new AppError("Coach session not found.", 404);
  }
  async sessions(userId: string) {
    const result = await supabaseAdmin
      .from("coach_sessions")
      .select("id,title,created_at,updated_at,user_id")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    assertDatabaseResult(result.error);
    // Enrich with message_count via a cheap aggregate call. Single round-trip via head/count.
    const rows = result.data ?? [];
    if (rows.length === 0) return [] as Array<{
      id: string; title: string; created_at: string; updated_at: string; message_count: number;
    }>;
    const ids = rows.map((r) => r.id);
    const counts = await supabaseAdmin
      .from("coach_messages")
      .select("session_id", { count: "exact", head: false })
      .eq("user_id", userId)
      .in("session_id", ids);
    assertDatabaseResult(counts.error);
    const map = new Map<string, number>();
    (counts.data ?? []).forEach((row: { session_id: string }) => {
      map.set(row.session_id, (map.get(row.session_id) ?? 0) + 1);
    });
    return rows.map((r) => ({ ...r, message_count: map.get(r.id) ?? 0 }));
  }
  async createSession(userId: string, title = "New Session") {
    const result = await supabaseAdmin.from("coach_sessions").insert({ user_id: userId, title }).select("*").single();
    assertDatabaseResult(result.error); return result.data;
  }
  async renameSession(userId: string, sessionId: string, title: string) {
    await this.assertSessionOwner(userId, sessionId);
    const result = await supabaseAdmin
      .from("coach_sessions")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .select("*")
      .single();
    assertDatabaseResult(result.error);
    return result.data;
  }
  async deleteSession(userId: string, sessionId: string) {
    await this.assertSessionOwner(userId, sessionId);
    const result = await supabaseAdmin
      .from("coach_sessions")
      .delete()
      .eq("id", sessionId)
      .eq("user_id", userId);
    assertDatabaseResult(result.error);
  }
  async messages(userId: string, sessionId: string) {
    await this.assertSessionOwner(userId, sessionId);
    const result = await supabaseAdmin.from("coach_messages").select("id,role,content,created_at").eq("user_id", userId).eq("session_id", sessionId).order("created_at");
    assertDatabaseResult(result.error); return result.data ?? [];
  }
  async addMessage(userId: string, sessionId: string, role: string, content: string) {
    await this.assertSessionOwner(userId, sessionId);
    const result = await supabaseAdmin.from("coach_messages").insert({ user_id:userId,session_id:sessionId,role,content }).select("*").single();
    assertDatabaseResult(result.error);
    await supabaseAdmin.from("coach_sessions").update({ updated_at: new Date().toISOString() }).eq("id", sessionId).eq("user_id", userId);
    return result.data;
  }
}

export class MilestoneRepository {
  async list(userId: string, goalId: string) {
    const result = await supabaseAdmin
      .from("goal_milestones")
      .select("id, goal_id, title, target_date, sort_order, completed_at, created_at")
      .eq("user_id", userId)
      .eq("goal_id", goalId)
      .order("sort_order", { ascending: true });
    assertDatabaseResult(result.error);
    return result.data ?? [];
  }

  async bulkInsert(userId: string, goalId: string, items: Array<{ title: string; target_date?: string; sort_order?: number }>) {
    if (!items || items.length === 0) return [];
    const rows = items.map((m, idx) => ({
      user_id: userId,
      goal_id: goalId,
      title: m.title.trim(),
      target_date: m.target_date || null,
      sort_order: m.sort_order ?? idx,
    }));
    const result = await supabaseAdmin
      .from("goal_milestones")
      .insert(rows)
      .select("id, goal_id, title, target_date, sort_order, completed_at, created_at")
      .order("sort_order", { ascending: true });
    assertDatabaseResult(result.error);
    return result.data ?? [];
  }

  async setDone(userId: string, milestoneId: string, done: boolean) {
    const result = await supabaseAdmin
      .from("goal_milestones")
      .update({ completed_at: done ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("id", milestoneId)
      .select("*")
      .single();
    assertDatabaseResult(result.error);
    return result.data;
  }

  async remove(userId: string, milestoneId: string) {
    const result = await supabaseAdmin
      .from("goal_milestones")
      .delete()
      .eq("user_id", userId)
      .eq("id", milestoneId);
    assertDatabaseResult(result.error);
  }
}



/**
 * PersonaRepository — deterministic scoring + classification.
 * Aggregates habits, completions and milestones for a window-based
 * archetype. Persists to persona_profiles (UPSERT) for cache reads.
 */
export class PersonaRepository {
  async compute(userId: string, windowDays: number) {
    const w = Math.max(1, Math.min(60, windowDays));
    const today = new Date();
    const since = new Date(today.getTime() - w * 24 * 60 * 60 * 1000);
    const sinceDate = since.toISOString().slice(0, 10);

    const { data: allHabits } = await supabaseAdmin
      .from("habits")
      .select("id, goal_id, difficulty, created_at")
      .eq("user_id", userId);
    const habits = (allHabits ?? []) as Array<{ id: string; goal_id: string; difficulty: string; created_at: string }>;

    const { data: allGoals } = await supabaseAdmin
      .from("goals")
      .select("id, progress")
      .eq("user_id", userId);
    const goals = (allGoals ?? []) as Array<{ id: string; progress: number }>;

    const { data: completions } = await supabaseAdmin
      .from("habit_completions")
      .select("habit_id, completion_date, completed")
      .eq("user_id", userId)
      .gte("completion_date", sinceDate);
    const completedRows = (completions ?? []) as Array<{ habit_id: string; completion_date: string; completed: boolean }>;
    const completedTrue = completedRows.filter(r => r.completed === true);
    const completedFalse = completedRows.filter(r => r.completed === false);

    const goalIds = goals.map(g => g.id);
    const milestonesResult = goalIds.length === 0
      ? { data: [] as any[] }
      : await supabaseAdmin
          .from("goal_milestones")
          .select("id, goal_id, completed_at")
          .in("goal_id", goalIds);
    const milestones = (milestonesResult.data ?? []) as Array<{ id: string; goal_id: string; completed_at: string | null }>;

    const last7Cut = today.getTime() - 7 * 24 * 60 * 60 * 1000;
    const last7Iso = new Date(last7Cut).toISOString().slice(0, 10);
    const completedLast7 = completedTrue.filter(r => r.completion_date >= last7Iso).length;
    const missedLast7 = completedFalse.filter(r => r.completion_date >= last7Iso).length;

    const completionRate = clampPct(safeDiv(completedTrue.length, completedRows.length) * 100);
    const expected = habits.length * w;
    const consistency = clampPct(safeDiv(completedTrue.length, expected) * 100);

    // Recovery: count gaps in completion dates that were followed by another streak
    const dates = Array.from(new Set(completedTrue.map(r => r.completion_date))).sort();
    const dateSet = new Set(dates);
    let breaksTaken = 0;
    let breaksRecovered = 0;
    let inBreakFlag = false;
    for (let i = dates.length - 1; i >= 0; i--) {
      const d = dates[i]!;
      const prev = new Date(new Date(d).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (!dateSet.has(prev) && i < dates.length - 1) {
        breaksTaken++;
        if (inBreakFlag) breaksRecovered++;
        else inBreakFlag = true;
      } else if (dateSet.has(prev)) {
        inBreakFlag = false;
      }
    }
    const recovery = clampPct(safeDiv(breaksRecovered, breaksTaken) * 100);

    let streak = 0;
    for (let i = 0; ; i++) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (dateSet.has(d)) streak++;
      else break;
      if (streak > 60) break;
    }
    const streak_hunter = clampPct(safeDiv(streak, 30) * 100);

    const totalMilestones = milestones.length || 1;
    const doneMilestones = milestones.filter(m => m.completed_at !== null).length;
    const completionist = clampPct(safeDiv(doneMilestones, totalMilestones) * 100);

    const prev7Start = last7Cut - 7 * 24 * 60 * 60 * 1000;
    const last7Count = completedTrue.filter(r => Date.parse(r.completion_date) >= last7Cut).length;
    const prev7Count = completedTrue.filter(r => {
      const t = Date.parse(r.completion_date);
      return t >= prev7Start && t < last7Cut;
    }).length;
    let momentum: number;
    if (prev7Count === 0 && last7Count === 0) momentum = 50;
    else if (prev7Count === 0) momentum = last7Count > 0 ? 80 : 50;
    else momentum = clampPct(((last7Count - prev7Count) / prev7Count) * 50 + 50);

    const diffBucket = { easy: 0, medium: 0, hard: 0 } as Record<Difficulty, number>;
    for (const h of habits) {
      const k = (h.difficulty as Difficulty) ?? "medium";
      diffBucket[k] = (diffBucket[k] ?? 0) + 1;
    }
    const avgDifficulty: Difficulty =
      diffBucket.easy >= diffBucket.medium && diffBucket.easy >= diffBucket.hard
        ? "easy"
        : diffBucket.hard >= diffBucket.medium
          ? "hard"
          : "medium";

    const lastMonth = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const newHabitsLast30 = habits.filter(h => Date.parse(h.created_at) >= lastMonth.getTime()).length;

    const traits: PersonaFeatures = {
      consistency: Math.round(consistency),
      recovery: Math.round(recovery),
      completionist: Math.round(completionist),
      streak_hunter: Math.round(streak_hunter),
      momentum: Math.round(momentum),
    };

    const evidence: PersonaEvidence = {
      streaksRecovered: breaksRecovered,
      longestStreak: streak,
      completedLast7,
      missedLast7,
      completionRate,
      avgDifficulty,
      goalCount: goals.length,
      habitCount: habits.length,
      newHabitsLast30,
      windowDays: w,
    };

    const archetype = classifyArchetype(traits);
    const advice = deriveAdvice(archetype, traits, evidence);
    const headline = DEFAULT_HEADLINE[archetype];

    const generatedAt = new Date().toISOString();

    try {
      await supabaseAdmin.from("persona_profiles").upsert({
        user_id: userId,
        archetype,
        traits: traits as unknown as Record<string, unknown>,
        evidence: evidence as unknown as Record<string, unknown>,
        window_days: w,
        computed_at: generatedAt,
      }, { onConflict: "user_id" });
    } catch (e) {
      console.warn("[PersonaRepository] upsert best-effort failed:", (e as Error).message);
    }

    return {
      archetype,
      headline,
      traits,
      evidence,
      advice,
      generatedAt,
      windowDays: w,
    };
  }

  async getCached(userId: string, windowDays: number, freshnessMs: number) {
    const { data, error } = await supabaseAdmin
      .from("persona_profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const ageMs = Date.now() - new Date((data as any).computed_at).getTime();
    if (ageMs > freshnessMs) return null;
    if ((data as any).window_days !== windowDays) return null;
    return data;
  }

  async getCoachContext(userId: string, windowDays = 14): Promise<string> {
    const p = await this.compute(userId, windowDays);
    const lines: string[] = [];
    lines.push(`User Persona: ${p.archetype}`);
    lines.push(`Top traits (0-100):`);
    const entries = Object.entries(p.traits) as Array<[keyof PersonaFeatures, number]>;
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 3);
    const descMap: Record<keyof PersonaFeatures, string> = {
      consistency: "completes daily habits consistently",
      recovery: "comes back strong after streaks break",
      completionist: "finishes milestones steadily",
      streak_hunter: "builds and defends multi-day streaks",
      momentum: "completion rates are growing week-over-week",
    };
    for (const [k, v] of top) lines.push(`  ${k}: ${v} - ${descMap[k]}`);
    lines.push(`Difficulty recommendation: ${p.advice.difficulty}`);
    if (p.advice.habit.length > 0) {
      lines.push(`Recent habit advice:`);
      for (const h of p.advice.habit) lines.push(`  - ${h}`);
    }
    if (p.advice.suggestedMilestone) {
      lines.push(`Suggested next milestone: "${p.advice.suggestedMilestone.title}"`);
      lines.push(`  reason: ${p.advice.suggestedMilestone.reason}`);
    }
    return lines.join("\n");
  }
}

