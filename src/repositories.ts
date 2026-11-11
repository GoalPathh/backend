import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
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

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.floor((db - da) / (1000 * 60 * 60 * 24));
}

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
  habit: { active_days?: any; created_at?: Date | string; time_range?: string | null },
  dateKey: string,
  goalStartDate?: Date | string,
) {
  const activeDays = Array.isArray(habit.active_days) ? habit.active_days : [];
  const dayKey = scheduleDays[new Date(`${dateKey}T00:00:00`).getDay()]!;
  const createdDate = habit.created_at ? new Date(habit.created_at).toISOString().slice(0, 10) : "";
  const startsAt = goalStartDate ? new Date(goalStartDate).toISOString().slice(0, 10) : "";

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

function formatGoalForClient(g: any) {
  return {
    id: g.id,
    title: g.title,
    category: g.category,
    period: g.period,
    progress: Number(g.progress),
    start_date: g.start_date instanceof Date ? g.start_date.toISOString() : g.start_date,
    target_date: g.target_date instanceof Date ? g.target_date.toISOString() : g.target_date,
    reminder_enabled: g.reminder_enabled,
    notification_preference: g.notification_preference,
    created_at: g.created_at instanceof Date ? g.created_at.toISOString() : g.created_at,
    updated_at: g.updated_at instanceof Date ? g.updated_at.toISOString() : g.updated_at,
    habits: (g.habits ?? []).map((h: any) => ({
      id: h.id,
      title: h.title,
      duration: h.duration,
      difficulty: h.difficulty,
      time_range: h.time_range,
      reminder_time: h.reminder_time,
      active_days: Array.isArray(h.active_days) ? h.active_days : [],
      priority: h.priority,
      created_at: h.created_at instanceof Date ? h.created_at.toISOString() : h.created_at,
    })),
  };
}

export class GoalRepository {
  async list(userId: string) {
    const goals = await prisma.goal.findMany({
      where: { user_id: userId },
      include: { habits: true },
      orderBy: { created_at: "desc" },
    });
    return goals.map(formatGoalForClient);
  }

  async find(userId: string, id: string) {
    const goal = await prisma.goal.findFirst({
      where: { id, user_id: userId },
      include: { habits: true },
    });
    if (!goal) throw new AppError("Goal not found.", 404);
    return formatGoalForClient(goal);
  }

  async create(userId: string, input: any) {
    const { selectedHabits, selectedMilestones, ...goal } = input;
    const createdGoal = await prisma.goal.create({
      data: {
        user_id: userId,
        title: goal.title,
        category: goal.category ?? "other",
        period: goal.period,
        progress: goal.progress ?? 0,
        start_date: new Date(goal.startDate),
        target_date: new Date(goal.targetDate),
        reminder_enabled: goal.reminderEnabled ?? true,
        notification_preference: goal.notificationPreference ?? "all",
        habits: {
          create: (selectedHabits ?? []).map((habit: any) => ({
            user_id: userId,
            title: habit.title,
            duration: habit.duration,
            difficulty: habit.difficulty,
            time_range: habit.schedule?.timeRange ?? "anytime",
            reminder_time: habit.schedule?.reminderTime || null,
            active_days: habit.schedule?.activeDays ?? [],
            priority: habit.schedule?.priority ?? "medium",
          })),
        },
        goal_milestones: {
          create: (selectedMilestones ?? []).map((m: any, idx: number) => ({
            user_id: userId,
            title: String(m.title ?? "").trim(),
            target_date: m.target_date ? new Date(m.target_date) : null,
            sort_order: typeof m.sort_order === "number" ? m.sort_order : idx,
          })),
        },
      },
    });

    return this.find(userId, createdGoal.id);
  }

  async update(userId: string, id: string, input: any) {
    await this.find(userId, id);
    const data: Record<string, any> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.category !== undefined) data.category = input.category;
    if (input.period !== undefined) data.period = input.period;
    if (input.progress !== undefined) data.progress = input.progress;
    if (input.startDate !== undefined) data.start_date = new Date(input.startDate);
    if (input.targetDate !== undefined) data.target_date = new Date(input.targetDate);
    if (input.reminderEnabled !== undefined) data.reminder_enabled = input.reminderEnabled;
    if (input.notificationPreference !== undefined) data.notification_preference = input.notificationPreference;

    await prisma.goal.update({
      where: { id },
      data,
    });
    return this.find(userId, id);
  }

  async remove(userId: string, id: string) {
    await this.find(userId, id);
    await prisma.goal.delete({ where: { id } });
  }

  async dashboard(userId: string) {
    const goals = await this.list(userId);
    const performance = await new DashboardRepository().getGoalPerformance(userId);
    const performanceMap = new Map(performance.map((item: any) => [item.id, item]));
    const goalIds = goals.map((goal: any) => goal.id);

    const milestones = goalIds.length === 0
      ? []
      : await prisma.goalMilestone.findMany({
          where: {
            user_id: userId,
            goal_id: { in: goalIds },
          },
          select: { id: true, goal_id: true, completed_at: true },
        });

    const milestonesByGoal = new Map<string, { total: number; completed: number }>();
    for (const milestone of milestones) {
      const current = milestonesByGoal.get(milestone.goal_id) ?? { total: 0, completed: 0 };
      current.total += 1;
      if (milestone.completed_at) current.completed += 1;
      milestonesByGoal.set(milestone.goal_id, current);
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
  async profile(userId: string) {
    const profile = await prisma.profile.findUnique({
      where: { id: userId },
    });
    if (profile) return profile;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("Profile not found.", 404);

    const email = user.email;
    const name = email.split("@")[0] || "GoalPath User";
    const usernameBase = name.toLowerCase().replace(/[^a-z0-9_]+/g, "") || "goalpath";
    const username = `@${usernameBase}`;

    return prisma.profile.create({
      data: {
        id: userId,
        name,
        username,
        avatar_url: "",
        xp: 0,
        streak_days: 0,
        level: 1,
      },
    });
  }

  async updateProfile(userId: string, input: any) {
    const data: Record<string, any> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.username !== undefined) data.username = input.username;
    if (input.avatarUrl !== undefined) data.avatar_url = input.avatarUrl;

    return prisma.profile.update({
      where: { id: userId },
      data,
    });
  }

  async preferences(userId: string) {
    const pref = await prisma.userPreference.findUnique({
      where: { user_id: userId },
    });
    if (pref) return pref;

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

  async updatePreferences(userId: string, input: any) {
    const data: Record<string, any> = {};
    if (input.appearance !== undefined) data.appearance = input.appearance;
    if (input.notifications !== undefined) data.notifications = input.notifications;

    return prisma.userPreference.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        appearance: input.appearance ?? "light",
        notifications: input.notifications ?? [],
      },
      update: data,
    });
  }

  createAvatarUploadSignature(userId: string) {
    if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
      throw new AppError("Cloudinary upload is not configured on the server.", 503);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `${config.cloudinaryUploadFolder.replace(/\/+$/, "")}/${userId}`;
    const publicId = `avatar-${timestamp}-${randomUUID().slice(0, 8)}`;
    const params = { folder, public_id: publicId, timestamp };
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

    const unreadNotifications = await prisma.notification.count({
      where: { user_id: userId, read_at: null },
    });

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
        unreadNotifications,
      },
    };
  }
}

export class DashboardRepository {
  async recomputeGoalProgress(userId: string, goalId: string): Promise<number> {
    const goal = await prisma.goal.findFirst({
      where: { id: goalId, user_id: userId },
      select: { id: true, start_date: true },
    });
    if (!goal) return 0;

    const habitCount = await prisma.habit.count({
      where: { goal_id: goalId },
    });
    if (habitCount === 0) {
      await prisma.goal.update({
        where: { id: goalId },
        data: { progress: 0 },
      });
      return 0;
    }

    const startDay = new Date(goal.start_date).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const eligibleDays = Math.max(1, daysBetween(startDay, today) + 1);

    const goalHabits = await prisma.habit.findMany({
      where: { goal_id: goalId },
      select: { id: true },
    });
    const habitIds = goalHabits.map((h) => h.id);

    const doneCount = await prisma.habitCompletion.count({
      where: {
        habit_id: { in: habitIds },
        completed: true,
        completion_date: {
          gte: new Date(startDay),
          lte: new Date(today),
        },
      },
    });

    const expected = habitCount * eligibleDays;
    const newProgress = Math.min(100, Number(((doneCount / expected) * 100).toFixed(2)));

    await prisma.goal.update({
      where: { id: goalId },
      data: { progress: newProgress },
    });

    return newProgress;
  }

  async getProgressDash(userId: string) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [completedLast7, missedLast7, totalCompletions, goals, streakRows, profile] = await Promise.all([
      prisma.habitCompletion.count({
        where: {
          user_id: userId,
          completed: true,
          completion_date: { gte: sevenDaysAgo },
        },
      }),
      prisma.habitCompletion.count({
        where: {
          user_id: userId,
          completed: false,
          completion_date: { gte: sevenDaysAgo },
        },
      }),
      prisma.habitCompletion.count({
        where: {
          user_id: userId,
          completed: true,
        },
      }),
      prisma.goal.findMany({
        where: { user_id: userId },
        select: { id: true },
      }),
      prisma.habitCompletion.findMany({
        where: { user_id: userId, completed: true },
        select: { completion_date: true },
        orderBy: { completion_date: "desc" },
        take: 60,
      }),
      prisma.profile.findUnique({
        where: { id: userId },
        select: { xp: true, streak_days: true, level: true },
      }),
    ]);

    const activeGoals = goals.length;
    let streak = 0;
    if (streakRows.length > 0) {
      const dates = new Set<string>(streakRows.map((r) => new Date(r.completion_date).toISOString().slice(0, 10)));
      for (let i = 0; ; i++) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        if (dates.has(d)) streak++;
        else break;
        if (streak > 60) break;
      }
    }

    const totalXp = totalCompletions * XP_PER_HABIT_COMPLETION;
    const completionRate = (completedLast7 + missedLast7) > 0
      ? Math.round((completedLast7 / (completedLast7 + missedLast7)) * 100)
      : 0;

    return {
      activeGoals,
      habitsCompleted7d: completedLast7,
      habitsMissed7d: missedLast7,
      totalCompletions,
      currentStreak: streak,
      totalXp,
      completionRate,
      profile: profile ?? { xp: totalXp, streak_days: streak, level: 1 },
    };
  }

  async getProgressOverview(userId: string, range: string) {
    const windowDays = resolveProgressRangeDays(range);
    const dateWindow = buildDateWindow(windowDays);
    const startDate = dateWindow[0]!;
    const endDate = dateWindow[dateWindow.length - 1]!;

    const [stats, goals, goalPerformance, profile, completions, milestones] = await Promise.all([
      this.getProgressDash(userId),
      new GoalRepository().list(userId),
      this.getGoalPerformance(userId),
      prisma.profile.findUnique({
        where: { id: userId },
        select: { xp: true, streak_days: true, level: true },
      }),
      prisma.habitCompletion.findMany({
        where: {
          user_id: userId,
          completion_date: {
            gte: new Date(startDate),
            lte: new Date(endDate),
          },
        },
        select: { habit_id: true, completion_date: true, completed: true },
      }),
      prisma.goalMilestone.findMany({
        where: { user_id: userId },
        select: { id: true, goal_id: true, completed_at: true },
      }),
    ]);

    const completionMap = new Map<string, boolean>();
    for (const row of completions) {
      const d = new Date(row.completion_date).toISOString().slice(0, 10);
      completionMap.set(`${row.habit_id}:${d}`, Boolean(row.completed));
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
    const completedMilestones = milestones.filter((row: any) => row.completed_at).length;
    const totalMilestones = milestones.length;
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
        totalXp: Number(stats.totalXp ?? profile?.xp ?? 0),
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

  async getGoalPerformance(userId: string) {
    const goals = await prisma.goal.findMany({
      where: { user_id: userId },
      select: { id: true, title: true, target_date: true, progress: true, start_date: true },
      orderBy: { created_at: "desc" },
    });

    const today = Date.now();
    return goals.map((g) => {
      const target = new Date(g.target_date).getTime();
      const daysLeft = Math.floor((target - today) / (1000 * 60 * 60 * 24));
      const prog = Number(g.progress);
      const pace = prog >= 100 ? "Completed"
                  : daysLeft < 7 ? "At Risk"
                  : prog >= 50 ? "On Track"
                  : "Behind Schedule";
      return {
        id: g.id,
        title: g.title,
        progress: prog,
        targetDate: g.target_date.toISOString(),
        status: pace,
        color: "bg-primary",
        daysLeft,
      };
    });
  }

  async setCompletion(userId: string, habitId: string, completed: boolean, completionDate?: string) {
    const habit = await prisma.habit.findFirst({
      where: { id: habitId, user_id: userId },
      select: { id: true, goal_id: true },
    });
    if (!habit) throw new AppError("Habit not found.", 404);

    const targetDateStr = completionDate ?? new Date().toISOString().slice(0, 10);
    const targetDate = new Date(targetDateStr);

    const existing = await prisma.habitCompletion.findUnique({
      where: {
        habit_id_completion_date: {
          habit_id: habitId,
          completion_date: targetDate,
        },
      },
    });

    const wasCompleted = Boolean(existing?.completed);
    const xpDelta = completed === wasCompleted ? 0 : completed ? XP_PER_HABIT_COMPLETION : -XP_PER_HABIT_COMPLETION;
    let completionResult: Record<string, any>;

    if (completed) {
      const result = await prisma.habitCompletion.upsert({
        where: {
          habit_id_completion_date: {
            habit_id: habitId,
            completion_date: targetDate,
          },
        },
        create: {
          habit_id: habitId,
          user_id: userId,
          completion_date: targetDate,
          completed: true,
          completed_at: new Date(),
        },
        update: {
          completed: true,
          completed_at: new Date(),
        },
      });
      completionResult = result;
    } else {
      await prisma.habitCompletion.deleteMany({
        where: {
          habit_id: habitId,
          user_id: userId,
          completion_date: targetDate,
        },
      });
      completionResult = { habit_id: habitId, completion_date: targetDateStr, completed: false };
    }

    if (xpDelta !== 0) {
      const totalCompleted = await prisma.habitCompletion.count({
        where: { user_id: userId, completed: true },
      });
      const nextXp = Math.max(0, totalCompleted * XP_PER_HABIT_COMPLETION);
      await prisma.profile.update({
        where: { id: userId },
        data: { xp: nextXp },
      });
      completionResult.xp_delta = xpDelta;
      completionResult.total_xp = nextXp;
    } else {
      completionResult.xp_delta = 0;
    }

    if (habit.goal_id) {
      try {
        await this.recomputeGoalProgress(userId, habit.goal_id);
      } catch (e) {
        console.error("[Dashboard] recompute fallback failed:", (e as Error).message);
      }
    }

    return completionResult;
  }

  async today(userId: string, tzOffset?: number) {
    const goals = await new GoalRepository().list(userId);
    let todayDate = new Date();
    if (tzOffset !== undefined) {
      todayDate = new Date(Date.now() - (tzOffset * 60 * 1000));
    }
    const today = todayDate.toISOString().slice(0, 10);
    const dayKey = scheduleDays[new Date(`${today}T00:00:00`).getDay()]!;

    const completions = await prisma.habitCompletion.findMany({
      where: {
        user_id: userId,
        completion_date: new Date(today),
      },
      select: { habit_id: true, completed: true },
    });

    const profile = await prisma.profile.findUnique({
      where: { id: userId },
      select: { name: true, username: true, avatar_url: true, xp: true, streak_days: true, level: true },
    });

    const stats = await this.getProgressDash(userId);
    const completionMap = new Map<string, boolean>(
      completions.map((row) => [row.habit_id, row.completed]),
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
    const currentStreak = Number(stats.currentStreak ?? profile?.streak_days ?? 0);
    const totalXp = Number(stats.totalXp ?? profile?.xp ?? 0);
    const level = Number(profile?.level ?? stats.profile?.level ?? 1);
    const focusQueue = habits.filter((habit: any) => !habit.completed).slice(0, 3);
    const nextHabitTitle = focusQueue[0]?.title;

    return {
      date: today,
      profile: {
        name: profile?.name ?? null,
        username: profile?.username ?? null,
        avatar_url: profile?.avatar_url ?? null,
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
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [profile, activeGoals, completions] = await Promise.all([
      prisma.profile.findUnique({
        where: { id: userId },
        select: { level: true, xp: true, streak_days: true },
      }),
      prisma.goal.findMany({
        where: { user_id: userId },
        select: { id: true, title: true, category: true, progress: true },
      }),
      prisma.habitCompletion.findMany({
        where: {
          user_id: userId,
          completion_date: { gte: sevenDaysAgo },
        },
        select: { completed: true },
      }),
    ]);

    const completed_count = completions.filter((c) => c.completed).length;
    const missed_count = completions.length - completed_count;

    return {
      profile: profile || { level: 1, xp: 0, streak_days: 0 },
      active_goals_count: activeGoals.length,
      active_goals: activeGoals.map((g) => ({ ...g, progress: Number(g.progress) })),
      performance_last_7_days: {
        completed_habits: completed_count,
        missed_habits: missed_count,
      },
    };
  }
}

export class SubscriptionRepository {
  async findByUser(userId: string) {
    return prisma.subscription.findUnique({ where: { user_id: userId } });
  }

  async upsertTier(userId: string, payload: Record<string, any>) {
    return prisma.subscription.upsert({
      where: { user_id: userId },
      create: { user_id: userId, ...payload },
      update: payload,
    });
  }

  async recordPayment(orderId: string, payload: Record<string, any>) {
    return prisma.paymentTransaction.upsert({
      where: { order_id: orderId },
      create: { order_id: orderId, user_id: payload.user_id, gross_amount: payload.gross_amount, status: payload.status, ...payload },
      update: payload,
    });
  }

  async listPaymentsForUser(userId: string, limit = 10) {
    return prisma.paymentTransaction.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: limit,
    });
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
    for (const row of rows) {
      const notifDate = new Date(row.notification_date);
      await prisma.notification.upsert({
        where: {
          user_id_type_source_key_notification_date: {
            user_id: userId,
            type: row.type,
            source_key: row.source_key,
            notification_date: notifDate,
          },
        },
        create: {
          user_id: userId,
          type: row.type,
          title: row.title,
          message: row.message,
          source_key: row.source_key,
          notification_date: notifDate,
          metadata: (row.metadata as any) ?? {},
        },
        update: {
          title: row.title,
          message: row.message,
          metadata: (row.metadata as any) ?? {},
        },
      });
    }
  }

  private async generateFlowNotifications(userId: string) {
    const now = new Date();
    const today = dateKey(now);
    const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterday = dateKey(yesterdayDate);
    const todayDay = notificationDays[now.getDay()]!;
    const yesterdayDay = notificationDays[yesterdayDate.getDay()]!;

    const goals = await prisma.goal.findMany({
      where: {
        user_id: userId,
        notification_preference: { not: "none" },
      },
      include: {
        habits: {
          select: { id: true, title: true, duration: true, time_range: true, active_days: true, priority: true },
        },
      },
      orderBy: { updated_at: "desc" },
    });

    const [todayCompletions, yesterdayCompletions] = await Promise.all([
      prisma.habitCompletion.findMany({
        where: {
          user_id: userId,
          completion_date: new Date(today),
        },
        select: { habit_id: true, completed: true },
      }),
      prisma.habitCompletion.findMany({
        where: {
          user_id: userId,
          completion_date: new Date(yesterday),
        },
        select: { habit_id: true, completed: true },
      }),
    ]);

    const todayDone = new Map(todayCompletions.map((row) => [row.habit_id, row.completed]));
    const yesterdayDone = new Map(yesterdayCompletions.map((row) => [row.habit_id, row.completed]));

    const generated: NotificationInput[] = [];
    const pendingToday: any[] = [];

    for (const goal of goals) {
      const habits = Array.isArray(goal.habits) ? goal.habits : [];
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

      const progress = Number(goal.progress) || 0;
      const targetDate = new Date(goal.target_date);
      const daysLeft = Math.ceil((targetDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

      if (Number.isFinite(daysLeft) && daysLeft >= 0 && daysLeft <= 7 && progress < 70) {
        generated.push({
          type: "goal_risk",
          title: `${goal.title} needs attention`,
          message: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left and progress is ${Math.round(progress)}%. Consider adjusting the plan or finishing one key habit today.`,
          source_key: `goal:${goal.id}:risk`,
          notification_date: today,
          metadata: { goalId: goal.id, progress, daysLeft },
        });
      }

      if (new Date(goal.updated_at).toISOString().slice(0, 10) === today && progress > 0) {
        generated.push({
          type: "progress_update",
          title: "Progress Update",
          message: `${goal.title} is now at ${Math.round(progress)}%. Keep the next action realistic.`,
          source_key: `goal:${goal.id}:progress`,
          notification_date: today,
          metadata: { goalId: goal.id, progress },
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

    const profile = await prisma.profile.findUnique({
      where: { id: userId },
      select: { streak_days: true },
    });

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

    const notifications = await prisma.notification.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: 20,
    });

    return notifications.map((n) => ({
      ...n,
      notification_date: n.notification_date instanceof Date ? n.notification_date.toISOString().slice(0, 10) : n.notification_date,
      created_at: n.created_at.toISOString(),
      updated_at: n.updated_at.toISOString(),
      read_at: n.read_at ? n.read_at.toISOString() : null,
    }));
  }

  async markAllRead(userId: string) {
    await prisma.notification.updateMany({
      where: { user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });
    return this.list(userId);
  }
}

export const MAX_COACH_SESSIONS = 10;

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i]! * vecB[i]!;
    normA += vecA[i]! * vecA[i]!;
    normB += vecB[i]! * vecB[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class CoachRepository {
  private async assertSessionOwner(userId: string, sessionId: string) {
    const session = await prisma.coachSession.findFirst({
      where: { id: sessionId, user_id: userId },
      select: { id: true },
    });
    if (!session) throw new AppError("Coach session not found.", 404);
  }

  async session(userId: string, sessionId: string) {
    const session = await prisma.coachSession.findFirst({
      where: { id: sessionId, user_id: userId },
      select: { id: true, title: true, created_at: true, updated_at: true },
    });
    if (!session) throw new AppError("Coach session not found.", 404);
    return {
      id: session.id,
      title: session.title,
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
    };
  }

  async sessions(userId: string) {
    const rows = await prisma.coachSession.findMany({
      where: { user_id: userId },
      select: {
        id: true,
        title: true,
        created_at: true,
        updated_at: true,
        user_id: true,
        _count: {
          select: { messages: true },
        },
      },
      orderBy: { updated_at: "desc" },
    });

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      user_id: r.user_id,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
      message_count: r._count.messages,
    }));
  }

  async createSession(userId: string, title = "New Session") {
    const existing = await prisma.coachSession.findMany({
      where: { user_id: userId },
      select: { id: true },
      orderBy: { updated_at: "desc" },
    });

    if (existing.length >= MAX_COACH_SESSIONS) {
      const toDelete = existing.slice(MAX_COACH_SESSIONS - 1).map((r) => r.id);
      if (toDelete.length > 0) {
        await prisma.coachSession.deleteMany({
          where: { id: { in: toDelete } },
        });
      }
    }

    const created = await prisma.coachSession.create({
      data: { user_id: userId, title },
    });
    return {
      id: created.id,
      title: created.title,
      created_at: created.created_at.toISOString(),
      updated_at: created.updated_at.toISOString(),
    };
  }

  async renameSession(userId: string, sessionId: string, title: string) {
    await this.assertSessionOwner(userId, sessionId);
    const updated = await prisma.coachSession.update({
      where: { id: sessionId },
      data: { title },
    });
    return {
      id: updated.id,
      title: updated.title,
      created_at: updated.created_at.toISOString(),
      updated_at: updated.updated_at.toISOString(),
    };
  }

  async deleteSession(userId: string, sessionId: string) {
    await this.assertSessionOwner(userId, sessionId);
    await prisma.coachSession.delete({
      where: { id: sessionId },
    });
  }

  async messages(userId: string, sessionId: string) {
    await this.assertSessionOwner(userId, sessionId);
    const rows = await prisma.coachMessage.findMany({
      where: { user_id: userId, session_id: sessionId },
      select: { id: true, role: true, content: true, created_at: true },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    return rows.reverse().map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      created_at: r.created_at.toISOString(),
    }));
  }

  async addMessage(userId: string, sessionId: string, role: string, content: string, embedding?: number[]) {
    await this.assertSessionOwner(userId, sessionId);
    const msg = await prisma.coachMessage.create({
      data: {
        user_id: userId,
        session_id: sessionId,
        role,
        content,
        embedding: embedding && embedding.length > 0 ? (embedding as any) : undefined,
      },
    });

    await prisma.coachSession.update({
      where: { id: sessionId },
      data: { updated_at: new Date() },
    });

    return {
      id: msg.id,
      session_id: msg.session_id,
      user_id: msg.user_id,
      role: msg.role,
      content: msg.content,
      created_at: msg.created_at.toISOString(),
    };
  }

  async searchRelevantMessages(userId: string, sessionId: string, embedding: number[], matchCount = 5) {
    await this.assertSessionOwner(userId, sessionId);
    if (!embedding || embedding.length === 0) return [];

    const messages = await prisma.coachMessage.findMany({
      where: {
        user_id: userId,
        session_id: sessionId,
        embedding: { not: null as any },
      },
      select: { id: true, role: true, content: true, embedding: true },
      take: 100,
    });

    const scored = messages
      .map((m) => {
        const emb = Array.isArray(m.embedding) ? (m.embedding as number[]) : [];
        const sim = emb.length > 0 ? cosineSimilarity(embedding, emb) : 0;
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          similarity: sim,
        };
      })
      .filter((m) => m.similarity > 0.7)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, matchCount);

    return scored;
  }

  async getQuota(userId: string, maxMessagesPerDay: number, accessPercentage: number) {
    const today = new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(`${today}T00:00:00.000Z`);

    const used = await prisma.coachMessage.count({
      where: {
        user_id: userId,
        created_at: { gte: startOfDay },
      },
    });

    const remaining = Math.max(0, maxMessagesPerDay - used);
    return {
      max_messages: maxMessagesPerDay,
      used_messages: used,
      remaining_messages: remaining,
      access_percentage: accessPercentage,
      reset_at: `${today}T23:59:59.999Z`,
      window: "daily-utc" as const,
    };
  }
}

export class MilestoneRepository {
  async list(userId: string, goalId: string) {
    const rows = await prisma.goalMilestone.findMany({
      where: { user_id: userId, goal_id: goalId },
      orderBy: { sort_order: "asc" },
    });
    return rows.map((m) => ({
      id: m.id,
      goal_id: m.goal_id,
      title: m.title,
      target_date: m.target_date ? m.target_date.toISOString() : null,
      sort_order: m.sort_order,
      completed_at: m.completed_at ? m.completed_at.toISOString() : null,
      created_at: m.created_at.toISOString(),
    }));
  }

  async bulkInsert(userId: string, goalId: string, items: Array<{ title: string; target_date?: string; sort_order?: number }>) {
    if (!items || items.length === 0) return [];

    await prisma.goalMilestone.deleteMany({
      where: { user_id: userId, goal_id: goalId },
    });

    await prisma.goalMilestone.createMany({
      data: items.map((m, idx) => ({
        user_id: userId,
        goal_id: goalId,
        title: m.title.trim(),
        target_date: m.target_date ? new Date(m.target_date) : null,
        sort_order: m.sort_order ?? idx,
      })),
    });

    return this.list(userId, goalId);
  }

  async setDone(userId: string, milestoneId: string, done: boolean) {
    const updated = await prisma.goalMilestone.update({
      where: { id: milestoneId },
      data: {
        completed_at: done ? new Date() : null,
      },
    });
    return {
      id: updated.id,
      goal_id: updated.goal_id,
      title: updated.title,
      target_date: updated.target_date ? updated.target_date.toISOString() : null,
      sort_order: updated.sort_order,
      completed_at: updated.completed_at ? updated.completed_at.toISOString() : null,
      created_at: updated.created_at.toISOString(),
    };
  }

  async remove(userId: string, milestoneId: string) {
    await prisma.goalMilestone.deleteMany({
      where: { id: milestoneId, user_id: userId },
    });
  }
}

export class PersonaRepository {
  async compute(userId: string, windowDays: number) {
    const w = Math.max(1, Math.min(60, windowDays));
    const today = new Date();
    const since = new Date(today.getTime() - w * 24 * 60 * 60 * 1000);

    const [habits, goals, completions] = await Promise.all([
      prisma.habit.findMany({
        where: { user_id: userId },
        select: { id: true, goal_id: true, difficulty: true, created_at: true },
      }),
      prisma.goal.findMany({
        where: { user_id: userId },
        select: { id: true, progress: true },
      }),
      prisma.habitCompletion.findMany({
        where: {
          user_id: userId,
          completion_date: { gte: since },
        },
        select: { habit_id: true, completion_date: true, completed: true },
      }),
    ]);

    const completedTrue = completions.filter((r) => r.completed === true);
    const completedFalse = completions.filter((r) => r.completed === false);

    const goalIds = goals.map((g) => g.id);
    const milestones = goalIds.length === 0
      ? []
      : await prisma.goalMilestone.findMany({
          where: { goal_id: { in: goalIds } },
          select: { id: true, goal_id: true, completed_at: true },
        });

    const last7Cut = today.getTime() - 7 * 24 * 60 * 60 * 1000;
    const last7Iso = new Date(last7Cut).toISOString().slice(0, 10);
    const completedLast7 = completedTrue.filter((r) => new Date(r.completion_date).toISOString().slice(0, 10) >= last7Iso).length;
    const missedLast7 = completedFalse.filter((r) => new Date(r.completion_date).toISOString().slice(0, 10) >= last7Iso).length;

    const completionRate = clampPct(safeDiv(completedTrue.length, completions.length) * 100);
    const expected = habits.length * w;
    const consistency = clampPct(safeDiv(completedTrue.length, expected) * 100);

    const dates = Array.from(new Set(completedTrue.map((r) => new Date(r.completion_date).toISOString().slice(0, 10)))).sort();
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
    const doneMilestones = milestones.filter((m) => m.completed_at !== null).length;
    const completionist = clampPct(safeDiv(doneMilestones, totalMilestones) * 100);

    const prev7Start = last7Cut - 7 * 24 * 60 * 60 * 1000;
    const last7Count = completedTrue.filter((r) => new Date(r.completion_date).getTime() >= last7Cut).length;
    const prev7Count = completedTrue.filter((r) => {
      const t = new Date(r.completion_date).getTime();
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
    const newHabitsLast30 = habits.filter((h) => new Date(h.created_at).getTime() >= lastMonth.getTime()).length;

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
      await prisma.personaProfile.upsert({
        where: { user_id: userId },
        create: {
          user_id: userId,
          archetype,
          traits: traits as any,
          evidence: evidence as any,
          window_days: w,
          computed_at: new Date(generatedAt),
        },
        update: {
          archetype,
          traits: traits as any,
          evidence: evidence as any,
          window_days: w,
          computed_at: new Date(generatedAt),
        },
      });
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
    const data = await prisma.personaProfile.findUnique({
      where: { user_id: userId },
    });
    if (!data) return null;
    const ageMs = Date.now() - new Date(data.computed_at).getTime();
    if (ageMs > freshnessMs) return null;
    if (data.window_days !== windowDays) return null;
    return {
      archetype: data.archetype,
      traits: data.traits,
      evidence: data.evidence,
      window_days: data.window_days,
      computed_at: data.computed_at.toISOString(),
    };
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
