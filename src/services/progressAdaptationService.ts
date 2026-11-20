import { createHash } from "node:crypto";
import { AppError, assertDatabaseResult } from "../errors.js";
import { config } from "../config.js";
import { supabaseAdmin } from "../supabase.js";
import { generateProgressNarrative } from "../llm-client.js";
import { DashboardRepository, UserRepository } from "../repositories.js";

const RANGE_DAYS: Record<string, number> = {
  "last-7-days": 7,
  "last-30-days": 30,
  "last-3-months": 90,
  "last-6-months": 180,
  "last-year": 365,
  custom: 30,
};
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const TIME_LABELS: Record<string, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  anytime: "Anytime",
};

type Habit = {
  id: string;
  goal_id: string;
  goal_title: string;
  goal_progress: number;
  goal_start_date: string;
  goal_target_date: string;
  title: string;
  duration: number;
  difficulty: "easy" | "medium" | "hard";
  time_range: "anytime" | "morning" | "afternoon" | "evening";
  active_days: string[] | null;
  created_at: string;
};

type Changes = {
  title?: string;
  duration?: number;
  timeRange?: "anytime" | "morning" | "afternoon" | "evening";
  activeDays?: string[];
};

type Candidate = {
  goalId: string;
  goalTitle: string;
  habitId: string;
  habitTitle: string;
  type: "reduce_difficulty" | "optimize_schedule" | "habit_replacement" | "recovery_plan";
  title: string;
  reason: string;
  priority: number;
  changes: Changes;
  before: Record<string, unknown>;
  metric: string;
};

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return dateKey(date);
}

function datesBetween(start: string, end: string) {
  const dates: string[] = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

function percent(completed: number, scheduled: number) {
  return scheduled ? Math.round((completed / scheduled) * 100) : 0;
}

function dayIndex(date: string) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function isScheduled(habit: Habit, date: string) {
  if (habit.created_at.slice(0, 10) > date || habit.goal_start_date.slice(0, 10) > date) return false;
  const activeDays = Array.isArray(habit.active_days) ? habit.active_days : [];
  return activeDays.length === 0 || activeDays.includes(DAY_KEYS[dayIndex(date)]!);
}

function summarizeDates(habits: Habit[], dates: string[], completions: Map<string, boolean>, today: string) {
  const days = dates.map((date) => {
    const scheduled = habits.filter((habit) => isScheduled(habit, date));
    const completed = scheduled.filter((habit) => completions.get(`${habit.id}:${date}`) === true);
    const pending = date === today ? scheduled.length - completed.length : 0;
    const due = scheduled.length - pending;
    return {
      date,
      weekday: dayIndex(date),
      scheduled: due,
      planned: scheduled.length,
      pending,
      completed: completed.length,
      missed: due - completed.length,
      rate: percent(completed.length, due),
      active: completed.length > 0,
    };
  });
  const scheduled = days.reduce((sum, day) => sum + day.scheduled, 0);
  const completed = days.reduce((sum, day) => sum + day.completed, 0);
  const activeDays = days.filter((day) => day.active).length;
  const weekdayStats = DAY_LABELS.map((label, weekday) => {
    const rows = days.filter((day) => day.weekday === weekday);
    const dayScheduled = rows.reduce((sum, day) => sum + day.scheduled, 0);
    const dayPlanned = rows.reduce((sum, day) => sum + day.planned, 0);
    const dayPending = rows.reduce((sum, day) => sum + day.pending, 0);
    const dayCompleted = rows.reduce((sum, day) => sum + day.completed, 0);
    return {
      day: label,
      key: DAY_KEYS[weekday],
      observations: rows.filter((day) => day.scheduled > 0).length,
      scheduled: dayScheduled,
      planned: dayPlanned,
      pending: dayPending,
      completed: dayCompleted,
      missed: dayScheduled - dayCompleted,
      completionRate: dayScheduled ? percent(dayCompleted, dayScheduled) : null,
    };
  });
  return {
    days,
    scheduled,
    plannedScheduled: days.reduce((sum, day) => sum + day.planned, 0),
    pending: days.reduce((sum, day) => sum + day.pending, 0),
    completed,
    missed: scheduled - completed,
    completionRate: percent(completed, scheduled),
    activeDays,
    dayCount: dates.length,
    weekdayStats,
  };
}

function habitStats(habits: Habit[], dates: string[], completions: Map<string, boolean>, today: string) {
  return habits.map((habit) => {
    const scheduledDates = dates.filter((date) => isScheduled(habit, date));
    const dueDates = scheduledDates.filter((date) => date !== today || completions.get(`${habit.id}:${date}`) === true);
    const completed = dueDates.filter((date) => completions.get(`${habit.id}:${date}`) === true).length;
    const weekdayStats = DAY_LABELS.map((day, weekday) => {
      const weekdayDates = scheduledDates.filter((date) => dayIndex(date) === weekday);
      const weekdayCompleted = weekdayDates.filter((date) => completions.get(`${habit.id}:${date}`) === true).length;
      const pending = weekdayDates.filter((date) => date === today && completions.get(`${habit.id}:${date}`) !== true).length;
      const due = weekdayDates.length - pending;
      return {
        day,
        key: DAY_KEYS[weekday],
        observations: weekdayDates.filter((date) => date !== today || completions.get(`${habit.id}:${date}`) === true).length,
        scheduled: due,
        planned: weekdayDates.length,
        pending,
        completed: weekdayCompleted,
        missed: due - weekdayCompleted,
        completionRate: due ? percent(weekdayCompleted, due) : null,
      };
    });
    return {
      habit,
      scheduled: dueDates.length,
      plannedScheduled: scheduledDates.length,
      pending: scheduledDates.length - dueDates.length,
      completed,
      missed: dueDates.length - completed,
      completionRate: percent(completed, dueDates.length),
      weekdayStats,
    };
  });
}

function goalPace(habit: Habit, progress: number, today: string) {
  const start = habit.goal_start_date.slice(0, 10);
  const target = habit.goal_target_date.slice(0, 10);
  const totalDays = Math.max(1, Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000));
  const elapsedDays = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000));
  const expectedProgress = Math.min(100, Math.round((elapsedDays / totalDays) * 100));
  const daysLeft = Math.ceil((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const behindBy = Math.max(0, expectedProgress - progress);
  return {
    expectedProgress,
    daysLeft,
    behindBy,
    behind: progress < 100 && (daysLeft < 0 || behindBy >= 15),
  };
}

function insightRows(
  period: ReturnType<typeof summarizeDates>,
  perHabit: ReturnType<typeof habitStats>,
  goals: Array<{ id: string; title: string; progress: number; status: string }>,
) {
  const rows: Array<{ id: string; title: string; observation: string; reason: string; recommendation: string }> = [];
  const observedDays = period.weekdayStats.filter((day) => day.scheduled > 0);
  if (observedDays.length > 0) {
    const best = [...observedDays].sort((a, b) => (b.completionRate ?? 0) - (a.completionRate ?? 0))[0]!;
    const weakest = [...observedDays].sort((a, b) => (a.completionRate ?? 0) - (b.completionRate ?? 0))[0]!;
    if (best.completionRate !== null && weakest.completionRate !== null && best.day !== weakest.day && best.scheduled >= 2 && weakest.scheduled >= 2) {
      rows.push({
        id: "weekday-pattern",
        title: "Weekday pattern",
        observation: `${best.day} has the highest completion rate at ${best.completionRate}%; ${weakest.day} is lowest at ${weakest.completionRate}%.`,
        reason: `Both days had scheduled habits in the selected period (${best.completed}/${best.scheduled} on ${best.day}, ${weakest.completed}/${weakest.scheduled} on ${weakest.day}).`,
        recommendation: `Keep demanding habits on ${best.day}, and reduce or move a flexible habit away from ${weakest.day}.`,
      });
    }
  }

  const timeStats = (Object.keys(TIME_LABELS) as Array<keyof typeof TIME_LABELS>)
    .filter((slot) => slot !== "anytime")
    .map((slot) => {
      const matching = perHabit.filter((row) => row.habit.time_range === slot);
      const scheduled = matching.reduce((sum, row) => sum + row.scheduled, 0);
      const completed = matching.reduce((sum, row) => sum + row.completed, 0);
      return { slot, scheduled, completed, rate: percent(completed, scheduled) };
    })
    .filter((slot) => slot.scheduled >= 3)
    .sort((a, b) => b.rate - a.rate);
  if (timeStats.length) {
    const best = timeStats[0]!;
    rows.push({
      id: "time-slot-pattern",
      title: "Scheduled time slot",
      observation: `${TIME_LABELS[best.slot]} habits have the highest completion rate at ${best.rate}%.`,
      reason: `${best.completed} of ${best.scheduled} scheduled habits in this time slot were completed.`,
      recommendation: `Try placing flexible habits in the ${TIME_LABELS[best.slot]!.toLowerCase()} slot.`,
    });
  }

  const difficultHabit = [...perHabit]
    .filter((row) => row.scheduled >= 4)
    .sort((a, b) => a.completionRate - b.completionRate)[0];
  if (difficultHabit && difficultHabit.completionRate < 50) {
    rows.push({
      id: "habit-load",
      title: "Habit may need a smaller start",
      observation: `“${difficultHabit.habit.title}” was completed ${difficultHabit.completed} of ${difficultHabit.scheduled} scheduled times.`,
      reason: `Its completion rate is ${difficultHabit.completionRate}% across the selected range.`,
      recommendation: difficultHabit.habit.duration > 10
        ? `Consider reducing its ${difficultHabit.habit.duration}-minute duration before changing the rest of your plan.`
        : "Try an even smaller first step and keep the schedule manageable.",
    });
  } else {
    const behind = goals.find((goal) => goal.status === "Behind Schedule");
    if (behind) {
      rows.push({
        id: "goal-pace",
        title: "Goal pace",
        observation: `“${behind.title}” is at ${behind.progress}% progress.`,
        reason: "Goal progress is compared with elapsed time up to its target date.",
        recommendation: "Review the goal's lowest-completion habit and choose one realistic recovery action.",
      });
    }
  }
  return rows.slice(0, 3);
}

function buildCandidates(
  userId: string,
  range: string,
  habits: Habit[],
  period: ReturnType<typeof summarizeDates>,
  perHabit: ReturnType<typeof habitStats>,
  today: string,
  onlyGoalId?: string,
): Candidate[] {
  const supportedDays = period.weekdayStats
    .filter((day) => day.scheduled >= 2 && day.completionRate !== null)
    .sort((a, b) => (b.completionRate ?? 0) - (a.completionRate ?? 0));
  const productiveDays: string[] = supportedDays.slice(0, 2).flatMap((day) => day.key ? [day.key] : []);
  const candidates: Candidate[] = [];

  for (const stats of perHabit) {
    const habit = stats.habit;
    if (onlyGoalId && habit.goal_id !== onlyGoalId) continue;
    const before = {
      title: habit.title,
      duration: habit.duration,
      difficulty: habit.difficulty,
      timeRange: habit.time_range,
      activeDays: Array.isArray(habit.active_days) ? habit.active_days : [],
      baselineCompletionRate: stats.completionRate,
      baselineCompleted: stats.completed,
      baselineScheduled: stats.scheduled,
      goalProgress: habit.goal_progress,
    };
    const pace = goalPace(habit, habit.goal_progress, today);

    if (pace.behind && stats.scheduled >= 3 && stats.completionRate < 70) {
      const changes: Changes = {};
      const activeDays = Array.isArray(habit.active_days) ? habit.active_days : [];
      if (habit.duration > 10) changes.duration = Math.max(5, Math.round((habit.duration / 2) / 5) * 5);
      else if (habit.duration > 5) changes.duration = 5;
      if (productiveDays.length && (activeDays.length === 0 || activeDays.length >= 4) && productiveDays.join(",") !== activeDays.join(",")) {
        changes.activeDays = productiveDays;
      }
      if (Object.keys(changes).length) candidates.push({
        goalId: habit.goal_id,
        goalTitle: habit.goal_title,
        habitId: habit.id,
        habitTitle: habit.title,
        type: "recovery_plan",
        title: "Build a realistic recovery plan",
        reason: `The goal is ${pace.behindBy} points behind its time-based pace, and “${habit.title}” is at ${stats.completionRate}% (${stats.completed}/${stats.scheduled}).`,
        priority: 0,
        changes,
        before,
        metric: `${habit.goal_progress}:${stats.completionRate}:${stats.scheduled}`,
      });
      continue;
    }

    if (stats.scheduled >= 4 && stats.completionRate < 50 && habit.duration > 5) {
      if (stats.completionRate <= 20 && stats.missed >= 4) {
        const title = `5-minute starter: ${habit.title}`.slice(0, 120);
        candidates.push({
          goalId: habit.goal_id,
          goalTitle: habit.goal_title,
          habitId: habit.id,
          habitTitle: habit.title,
          type: "habit_replacement",
          title: "Replace it with a smaller first step",
          reason: `“${habit.title}” was missed ${stats.missed} of ${stats.scheduled} scheduled times. A 5-minute starter keeps the same goal direction with a lower entry cost.`,
          priority: 1,
          changes: { title, duration: 5 },
          before,
          metric: `${stats.completionRate}:${stats.scheduled}`,
        });
      } else {
        const duration = Math.max(5, Math.round((habit.duration / 2) / 5) * 5);
        candidates.push({
          goalId: habit.goal_id,
          goalTitle: habit.goal_title,
          habitId: habit.id,
          habitTitle: habit.title,
          type: "reduce_difficulty",
          title: "Make this habit easier to complete",
          reason: `“${habit.title}” was completed ${stats.completed} of ${stats.scheduled} scheduled times at its current ${habit.duration}-minute duration.`,
          priority: 2,
          changes: { duration },
          before,
          metric: `${stats.completionRate}:${stats.scheduled}:${habit.duration}`,
        });
      }
      continue;
    }

    const activeDays = Array.isArray(habit.active_days) ? habit.active_days : [];
    const flexibleSchedule = activeDays.length === 0 || activeDays.length >= 4;
    const scheduledOnWeakDay = stats.weekdayStats.some(
      (day) => day.scheduled >= 2 && day.completionRate !== null && day.completionRate < 50 && (!day.key || activeDays.length === 0 || activeDays.includes(day.key)),
    );
    if (stats.scheduled >= 6 && productiveDays.length && flexibleSchedule && scheduledOnWeakDay) {
      const nextDays = productiveDays;
      if (nextDays.length && nextDays.join(",") !== activeDays.join(",")) {
        candidates.push({
          goalId: habit.goal_id,
          goalTitle: habit.goal_title,
          habitId: habit.id,
          habitTitle: habit.title,
          type: "optimize_schedule",
          title: "Move this flexible habit to stronger days",
          reason: `Your strongest supported weekdays are ${productiveDays.map((day) => DAY_LABELS[DAY_KEYS.indexOf(day as typeof DAY_KEYS[number])] ?? day).join(" and ")}; this habit has a completion rate below 50% on one of its current days.`,
          priority: 3,
          changes: { activeDays: nextDays },
          before,
          metric: `${productiveDays.join(",")}:${stats.completionRate}:${stats.scheduled}`,
        });
      }
    }
  }

  return candidates
    .sort((a, b) => a.priority - b.priority || a.goalTitle.localeCompare(b.goalTitle))
    .slice(0, 3)
    .map((candidate) => ({ ...candidate, metric: `${candidate.metric}:${range}:${userId}` }));
}

function adaptationId(userId: string, candidate: Candidate, range: string) {
  return createHash("sha256")
    .update(JSON.stringify([userId, range, candidate.goalId, candidate.habitId, candidate.type, candidate.changes, candidate.metric]))
    .digest("hex");
}

function toHabitSnapshot(row: Record<string, any>) {
  return {
    title: String(row.title),
    duration: Number(row.duration),
    difficulty: String(row.difficulty),
    timeRange: String(row.time_range),
    activeDays: Array.isArray(row.active_days) ? row.active_days : [],
  };
}

export class ProgressAdaptationService {
  async get(userId: string, range: string, onlyGoalId?: string) {
    const windowDays = RANGE_DAYS[range] ?? 7;
    const today = dateKey(new Date());
    const start = shiftDate(today, -(windowDays - 1));
    const previousStart = shiftDate(start, -windowDays);
    const previousEnd = shiftDate(start, -1);
    const allDates = datesBetween(previousStart, today);
    const [goalsResult, completionsResult, preferences] = await Promise.all([
      supabaseAdmin
        .from("goals")
        .select("id,title,progress,start_date,target_date,habits(id,goal_id,title,duration,difficulty,time_range,active_days,created_at)")
        .eq("user_id", userId),
      supabaseAdmin
        .from("habit_completions")
        .select("habit_id,completion_date,completed")
        .eq("user_id", userId)
        .gte("completion_date", previousStart)
        .lte("completion_date", today),
      new UserRepository().preferences(userId),
    ]);
    assertDatabaseResult(goalsResult.error);
    assertDatabaseResult(completionsResult.error);

    const goals = (goalsResult.data ?? []) as Array<Record<string, any>>;
    const goalById = new Map(goals.map((goal) => [goal.id, goal]));
    if (onlyGoalId && !goalById.has(onlyGoalId)) throw new AppError("Goal not found.", 404);
    const habits: Habit[] = goals.flatMap((goal) => (goal.habits ?? []).map((habit: Record<string, any>) => ({
      ...habit,
      goal_id: goal.id,
      goal_title: goal.title,
      goal_progress: Number(goal.progress ?? 0),
      goal_start_date: goal.start_date,
      goal_target_date: goal.target_date,
    })));
    const completions = new Map<string, boolean>();
    for (const row of completionsResult.data ?? []) {
      completions.set(`${row.habit_id}:${row.completion_date}`, row.completed === true);
    }

    const selectedDates = datesBetween(start, today);
    const previousDates = datesBetween(previousStart, previousEnd);
    const selectedHabits = onlyGoalId ? habits.filter((habit) => habit.goal_id === onlyGoalId) : habits;
    const current = summarizeDates(selectedHabits, selectedDates, completions, today);
    const previous = summarizeDates(selectedHabits, previousDates, completions, today);
    const habitRows = habitStats(selectedHabits, selectedDates, completions, today);
    const selectedGoals = (onlyGoalId ? goals.filter((goal) => goal.id === onlyGoalId) : goals).map((goal) => {
      const owned = habitRows.filter((row) => row.habit.goal_id === goal.id);
      const scheduled = owned.reduce((sum, row) => sum + row.scheduled, 0);
      const plannedScheduled = owned.reduce((sum, row) => sum + row.plannedScheduled, 0);
      const pendingToday = owned.reduce((sum, row) => sum + row.pending, 0);
      const completed = owned.reduce((sum, row) => sum + row.completed, 0);
      const pace = goalPace(owned[0]?.habit ?? {
        goal_start_date: goal.start_date,
        goal_target_date: goal.target_date,
      } as Habit, Number(goal.progress ?? 0), today);
      const weekdayStats = DAY_LABELS.map((day, weekday) => {
        const scheduledForDay = owned.reduce((sum, row) => sum + row.weekdayStats[weekday]!.scheduled, 0);
        const plannedForDay = owned.reduce((sum, row) => sum + row.weekdayStats[weekday]!.planned, 0);
        const pendingForDay = owned.reduce((sum, row) => sum + row.weekdayStats[weekday]!.pending, 0);
        const completedForDay = owned.reduce((sum, row) => sum + row.weekdayStats[weekday]!.completed, 0);
        return {
          day,
          key: DAY_KEYS[weekday],
          observations: selectedDates.filter((date) => dayIndex(date) === weekday && owned.some((row) =>
            isScheduled(row.habit, date) && (date !== today || completions.get(`${row.habit.id}:${date}`) === true),
          )).length,
          scheduled: scheduledForDay,
          planned: plannedForDay,
          pending: pendingForDay,
          completed: completedForDay,
          missed: scheduledForDay - completedForDay,
          completionRate: scheduledForDay ? percent(completedForDay, scheduledForDay) : null,
        };
      });
      const observedDays = weekdayStats.filter((day) => day.scheduled > 0);
      const bestDays = [...observedDays]
        .filter((day) => day.scheduled >= 2)
        .sort((a, b) => (b.completionRate ?? 0) - (a.completionRate ?? 0))
        .slice(0, 2)
        .map((day) => day.day);
      const missedDays = [...observedDays]
        .filter((day) => day.missed > 0)
        .sort((a, b) => b.missed - a.missed || (a.completionRate ?? 100) - (b.completionRate ?? 100))
        .slice(0, 2)
        .map((day) => day.day);
      const weakHabits = owned.filter((row) => row.scheduled >= 3).sort((a, b) => a.completionRate - b.completionRate);
      const insight = scheduled < 6 || completed < 2
        ? "There is not enough scheduled activity in this range to identify a reliable goal pattern yet."
        : bestDays.length && missedDays.length
          ? `This goal is completed most consistently on ${bestDays.join(" and ")}. ${missedDays.join(" and ")} account for the most scheduled misses.`
          : `This goal has a ${percent(completed, scheduled)}% completion rate across ${scheduled} scheduled habit opportunities.`;
      const priorRows = habitStats(owned.map((row) => row.habit), previousDates, completions, today);
      const priorScheduled = priorRows.reduce((sum, row) => sum + row.scheduled, 0);
      const priorCompleted = priorRows.reduce((sum, row) => sum + row.completed, 0);
      const priorRate = percent(priorCompleted, priorScheduled);
      return {
        id: goal.id,
        title: goal.title,
        progress: Number(goal.progress ?? 0),
        targetDate: goal.target_date,
        status: pace.behind ? "Behind Schedule" : Number(goal.progress ?? 0) >= 100 ? "Completed" : "On Track",
        expectedProgress: pace.expectedProgress,
        daysLeft: pace.daysLeft,
        behindBy: pace.behindBy,
        completionRate: percent(completed, scheduled),
        completed,
        scheduled,
        plannedScheduled,
        pendingToday,
        missed: scheduled - completed,
        weeklyHabitCompletion: percent(completed, scheduled),
        consistencyTrend: scheduled < 6 || priorScheduled < 1 ? "insufficient-data" : percent(completed, scheduled) >= priorRate + 5 ? "up" : percent(completed, scheduled) <= priorRate - 5 ? "down" : "steady",
        bestDays,
        missedDays,
        weekdayStats,
        habits: owned.map((row) => ({
          id: row.habit.id,
          title: row.habit.title,
          duration: row.habit.duration,
          difficulty: row.habit.difficulty,
          completionRate: row.completionRate,
          completed: row.completed,
          scheduled: row.scheduled,
          pending: row.pending,
          missed: row.missed,
        })),
        bottleneckHabit: weakHabits[0] ? {
          title: weakHabits[0].habit.title,
          completionRate: weakHabits[0].completionRate,
          completed: weakHabits[0].completed,
          scheduled: weakHabits[0].scheduled,
          duration: weakHabits[0].habit.duration,
        } : null,
        insight,
      };
    });

    const productivityByDay = current.weekdayStats;
    const observedWeekdays = productivityByDay.filter((day) => day.scheduled > 0);
    const bestWeekday = [...observedWeekdays].sort((a, b) => (b.completionRate ?? 0) - (a.completionRate ?? 0))[0] ?? null;
    const leastWeekday = [...observedWeekdays].sort((a, b) => (a.completionRate ?? 0) - (b.completionRate ?? 0))[0] ?? null;
    const scheduledSlots = (Object.keys(TIME_LABELS) as Array<keyof typeof TIME_LABELS>)
      .filter((slot) => slot !== "anytime")
      .map((slot) => {
        const matching = habitRows.filter((row) => row.habit.time_range === slot);
        const scheduled = matching.reduce((sum, row) => sum + row.scheduled, 0);
        const completed = matching.reduce((sum, row) => sum + row.completed, 0);
        return { slot, label: TIME_LABELS[slot], scheduled, completed, completionRate: scheduled ? percent(completed, scheduled) : null };
      })
      .filter((slot) => slot.scheduled > 0);
    const bestTimeSlot = [...scheduledSlots].sort((a, b) => (b.completionRate ?? 0) - (a.completionRate ?? 0))[0] ?? null;
    const frequentlyMissedDays = [...productivityByDay]
      .filter((day) => (day.observations ?? 0) >= 2 && day.missed > 0)
      .sort((a, b) => b.missed - a.missed || (a.completionRate ?? 100) - (b.completionRate ?? 100))
      .slice(0, 3);
    const insights = insightRows(current, habitRows, selectedGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      progress: Number(goal.progress ?? 0),
      status: goal.status,
    })));
    const enoughData = current.scheduled >= 6 && current.completed >= 2;
    const coachPersonalizationEnabled = (preferences as any)?.privacy?.personalizedCoach !== false;
    const llmAvailable = Boolean(config.llmApiKey && config.llmApiKey !== "mock-key");
    let narrative = enoughData
      ? bestWeekday && leastWeekday && bestWeekday.day !== leastWeekday.day
        ? `${bestWeekday.day} has your highest completion rate (${bestWeekday.completionRate}%). ${leastWeekday.day} is currently lowest (${leastWeekday.completionRate}%). Review the habits scheduled on that day.`
        : `${current.completed} of ${current.scheduled} scheduled habit opportunities were completed in this period. Start with the habit that has the lowest completion rate.`
      : "More scheduled habit activity is needed before reliable patterns or recommendations can be shown.";
    let source: "ai" | "rules" | "insufficient-data" = enoughData ? "rules" : "insufficient-data";
    if (enoughData && coachPersonalizationEnabled && llmAvailable) {
      try {
        const generated = await generateProgressNarrative({
          range,
          scheduled: current.scheduled,
          completed: current.completed,
          missed: current.missed,
          pendingToday: current.pending,
          activeDays: current.activeDays,
          dayCount: current.dayCount,
          weekdays: productivityByDay.filter((day) => day.scheduled > 0),
          bestTimeSlot,
          insights: insights.map(({ observation, reason, recommendation }) => ({ observation, reason, recommendation })),
          goal: onlyGoalId ? selectedGoals[0] : undefined,
        });
        if (generated) {
          narrative = generated;
          source = "ai";
        }
      } catch {
        source = "rules";
      }
    }

    const selectedHabitIds = selectedHabits.map((habit) => habit.id);
    const recentAppliedResult = selectedHabitIds.length
      ? await supabaseAdmin
          .from("habit_adaptation_history")
          .select("habit_id,resolved_at")
          .eq("user_id", userId)
          .eq("status", "applied")
          .in("habit_id", selectedHabitIds)
          .gte("resolved_at", `${start}T00:00:00.000Z`)
      : { data: [], error: null };
    assertDatabaseResult(recentAppliedResult.error);
    const suppressRepeatForHabit = new Set<string>();
    for (const applied of recentAppliedResult.data ?? []) {
      const habit = selectedHabits.find((row) => row.id === applied.habit_id);
      if (!habit || !applied.resolved_at) continue;
      const postStart = shiftDate(String(applied.resolved_at).slice(0, 10), 1);
      const postDates = postStart <= today ? datesBetween(postStart, today) : [];
      const postApplyStats = habitStats([habit], postDates, completions, today)[0];
      if (!postApplyStats || postApplyStats.scheduled < 4) {
        suppressRepeatForHabit.add(habit.id);
        continue;
      }
      const existingIndex = habitRows.findIndex((row) => row.habit.id === habit.id);
      if (existingIndex >= 0) habitRows[existingIndex] = postApplyStats;
    }

    const candidates = enoughData
      ? buildCandidates(userId, range, selectedHabits, current, habitRows, today, onlyGoalId)
          .filter((candidate) => !suppressRepeatForHabit.has(candidate.habitId))
      : [];
    const recommendationRows = candidates.map((candidate) => {
      const dedupeKey = adaptationId(userId, candidate, range);
      return {
        user_id: userId,
        goal_id: candidate.goalId,
        habit_id: candidate.habitId,
        dedupe_key: dedupeKey,
        recommendation: {
          type: candidate.type,
          title: candidate.title,
          reason: candidate.reason,
          goalTitle: candidate.goalTitle,
          habitTitle: candidate.habitTitle,
          changes: candidate.changes,
        },
        before_snapshot: candidate.before,
        status: "pending",
      };
    });
    if (recommendationRows.length) {
      const insert = await supabaseAdmin
        .from("habit_adaptation_history")
        .upsert(recommendationRows, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true });
      assertDatabaseResult(insert.error);
    }
    const candidateKeys = recommendationRows.map((row) => row.dedupe_key);
    const pendingQuery = candidateKeys.length
      ? await supabaseAdmin
          .from("habit_adaptation_history")
          .select("id,dedupe_key,goal_id,habit_id,recommendation,status,before_snapshot,created_at")
          .eq("user_id", userId)
          .in("dedupe_key", candidateKeys)
      : { data: [], error: null };
    assertDatabaseResult(pendingQuery.error);
    const pendingRecommendations = (pendingQuery.data ?? [])
      .filter((row: any) => row.status === "pending")
      .map((row: any) => ({ id: row.id, goalId: row.goal_id, habitId: row.habit_id, ...row.recommendation, before: row.before_snapshot, status: row.status }));

    let historyQuery = supabaseAdmin
      .from("habit_adaptation_history")
      .select("id,goal_id,habit_id,recommendation,status,before_snapshot,after_snapshot,created_at,resolved_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(12);
    if (onlyGoalId) historyQuery = historyQuery.eq("goal_id", onlyGoalId);
    const historyResult = await historyQuery;
    assertDatabaseResult(historyResult.error);
    const historyRows = (historyResult.data ?? []) as Array<Record<string, any>>;
    const appliedRows = historyRows.filter((row) => row.status === "applied" && row.habit_id && row.after_snapshot?.appliedAt);
    const historyHabitIds = [...new Set(appliedRows.map((row) => row.habit_id as string))];
    const followUpStart = appliedRows.length
      ? appliedRows.map((row) => shiftDate(String(row.after_snapshot.appliedAt).slice(0, 10), 1)).sort()[0]!
      : null;
    const followUpResult = historyHabitIds.length && followUpStart && followUpStart <= today
      ? await supabaseAdmin
          .from("habit_completions")
          .select("habit_id,completion_date,completed")
          .eq("user_id", userId)
          .in("habit_id", historyHabitIds)
          .gte("completion_date", followUpStart)
          .lte("completion_date", today)
      : { data: [], error: null };
    assertDatabaseResult(followUpResult.error);
    const followUpCompletions = new Map<string, boolean>();
    for (const row of followUpResult.data ?? []) followUpCompletions.set(`${row.habit_id}:${row.completion_date}`, row.completed === true);
    const history = historyRows.map((row: any) => {
      let after = row.after_snapshot;
      if (row.status === "applied" && row.habit_id && after?.appliedAt) {
        const appliedDate = shiftDate(String(after.appliedAt).slice(0, 10), 1);
        const nextAppliedAt = appliedRows
          .filter((other) => other.habit_id === row.habit_id && String(other.resolved_at ?? "") > String(row.resolved_at ?? ""))
          .map((other) => String(other.resolved_at).slice(0, 10))
          .sort()[0];
        const followUpEnd = nextAppliedAt ? shiftDate(nextAppliedAt, -1) : today;
        const appliedDays = appliedDate <= followUpEnd ? datesBetween(appliedDate, followUpEnd) : [];
        const activeDays = Array.isArray(after.activeDays) ? after.activeDays : [];
        const scheduledDates = appliedDays.filter((date) => activeDays.length === 0 || activeDays.includes(DAY_KEYS[dayIndex(date)]));
        const completed = scheduledDates.filter((date) => followUpCompletions.get(`${row.habit_id}:${date}`) === true).length;
        after = {
          ...after,
          followUp: {
            scheduled: scheduledDates.length,
            completed,
            completionRate: scheduledDates.length >= 4 ? percent(completed, scheduledDates.length) : null,
          },
        };
      }
      return {
        id: row.id,
        goalId: row.goal_id,
        habitId: row.habit_id,
        goalTitle: row.recommendation?.goalTitle ?? "Goal",
        habitTitle: row.recommendation?.habitTitle ?? "Habit",
        title: row.recommendation?.title ?? "Plan adaptation",
        type: row.recommendation?.type ?? "",
        status: row.status,
        before: row.before_snapshot,
        after,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      };
    });

    const selectedGoal = selectedGoals[0];
    const goalReview = selectedGoal ? {
      ...selectedGoal,
      narrative: selectedGoal.scheduled < 6 || selectedGoal.completed < 2
        ? "Keep logging scheduled habits to give the goal review enough evidence."
        : selectedGoal.insight,
      recommendations: pendingRecommendations.filter((row: any) => row.goalId === selectedGoal.id),
    } : null;

    return {
      range,
      windowDays,
      analysisSource: source,
      coachPersonalizationEnabled,
      hasEnoughData: enoughData,
      analysis: {
        narrative,
        insights,
        leastProductiveDay: leastWeekday && leastWeekday.scheduled > 0 ? leastWeekday : null,
        mostProductiveDay: bestWeekday && bestWeekday.scheduled > 0 && (bestWeekday.completionRate ?? 0) > 0 ? bestWeekday : null,
        frequentlyMissedDays,
        bestTimeSlot,
      },
      performance: {
        completionRate: current.completionRate,
        completed: current.completed,
        scheduled: current.scheduled,
        plannedScheduled: current.plannedScheduled,
        pendingToday: current.pending,
        missed: current.missed,
        activeDays: current.activeDays,
        dayCount: current.dayCount,
        consistencyScore: current.completionRate,
        previousCompletionRate: previous.completionRate,
        hasPreviousData: previous.scheduled > 0,
        changePoints: previous.scheduled > 0 ? current.completionRate - previous.completionRate : null,
      },
      productivityByDay,
      recommendations: pendingRecommendations,
      history,
      goalReview,
    };
  }

  async apply(userId: string, recommendationId: string, customChanges?: Changes) {
    const historyResult = await supabaseAdmin
      .from("habit_adaptation_history")
      .select("id,goal_id,habit_id,recommendation,status")
      .eq("user_id", userId)
      .eq("id", recommendationId)
      .maybeSingle();
    assertDatabaseResult(historyResult.error);
    const history = historyResult.data as any;
    if (!history) throw new AppError("Recommendation not found.", 404);
    if (history.status !== "pending") throw new AppError("This recommendation has already been resolved.", 409);

    const [habitResult, goalResult] = await Promise.all([
      supabaseAdmin
        .from("habits")
        .select("id,goal_id,title,duration,difficulty,time_range,active_days,priority")
        .eq("user_id", userId)
        .eq("goal_id", history.goal_id)
        .eq("id", history.habit_id)
        .maybeSingle(),
      supabaseAdmin.from("goals").select("progress").eq("user_id", userId).eq("id", history.goal_id).maybeSingle(),
    ]);
    assertDatabaseResult(habitResult.error);
    assertDatabaseResult(goalResult.error);
    if (!habitResult.data) throw new AppError("The habit for this recommendation no longer exists.", 404);

    const habit = habitResult.data as Record<string, any>;
    const suggested = history.recommendation?.changes ?? {};
    const changes: Changes = customChanges ?? suggested;
    if (!Object.keys(changes).length) throw new AppError("Choose at least one plan change.", 400);
    const appliedAt = new Date().toISOString();
    const claim = await supabaseAdmin
      .from("habit_adaptation_history")
      .update({ status: "applied", resolved_at: appliedAt })
      .eq("user_id", userId)
      .eq("id", recommendationId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    assertDatabaseResult(claim.error);
    if (!claim.data) throw new AppError("This recommendation has already been resolved.", 409);
    const baseline = history.before_snapshot ?? {};
    const before = {
      ...toHabitSnapshot(habit),
      baselineCompletionRate: baseline.baselineCompletionRate ?? null,
      baselineCompleted: baseline.baselineCompleted ?? null,
      baselineScheduled: baseline.baselineScheduled ?? null,
      goalProgress: Number(goalResult.data?.progress ?? baseline.goalProgress ?? 0),
    };
    const after = {
      ...before,
      ...(changes.title !== undefined && { title: changes.title.trim().slice(0, 120) }),
      ...(changes.duration !== undefined && { duration: changes.duration }),
      ...(changes.timeRange !== undefined && { timeRange: changes.timeRange }),
      ...(changes.activeDays !== undefined && { activeDays: changes.activeDays }),
      appliedAt,
    };
    const updateResult = await supabaseAdmin
      .from("habits")
      .update({
        ...(changes.title !== undefined && { title: after.title }),
        ...(changes.duration !== undefined && { duration: after.duration }),
        ...(changes.timeRange !== undefined && { time_range: after.timeRange }),
        ...(changes.activeDays !== undefined && { active_days: after.activeDays }),
      })
      .eq("user_id", userId)
      .eq("goal_id", history.goal_id)
      .eq("id", history.habit_id)
      .select("id")
      .maybeSingle();
    if (updateResult.error) {
      await supabaseAdmin.from("habit_adaptation_history").update({ status: "pending", resolved_at: null }).eq("user_id", userId).eq("id", recommendationId).eq("status", "applied");
      assertDatabaseResult(updateResult.error);
    }
    if (!updateResult.data) {
      await supabaseAdmin.from("habit_adaptation_history").update({ status: "pending", resolved_at: null }).eq("user_id", userId).eq("id", recommendationId).eq("status", "applied");
      throw new AppError("The habit for this recommendation no longer exists.", 404);
    }

    const recorded = await supabaseAdmin
      .from("habit_adaptation_history")
      .update({ before_snapshot: before, after_snapshot: after })
      .eq("user_id", userId)
      .eq("id", recommendationId)
      .eq("status", "applied");
    if (recorded.error) {
      await supabaseAdmin.from("habits").update({
        title: before.title,
        duration: before.duration,
        time_range: before.timeRange,
        active_days: before.activeDays,
      }).eq("user_id", userId).eq("id", history.habit_id);
      await supabaseAdmin.from("habit_adaptation_history").update({ status: "pending", resolved_at: null, before_snapshot: baseline, after_snapshot: null }).eq("user_id", userId).eq("id", recommendationId).eq("status", "applied");
      assertDatabaseResult(recorded.error);
    }
    try {
      await new DashboardRepository().recomputeGoalProgress(userId, history.goal_id);
    } catch (error) {
      console.error("[ProgressAdaptation] goal progress recompute failed:", (error as Error).message);
    }
    return { id: recommendationId, status: "applied", before, after };
  }

  async dismiss(userId: string, recommendationId: string) {
    const result = await supabaseAdmin
      .from("habit_adaptation_history")
      .update({ status: "dismissed", resolved_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("id", recommendationId)
      .eq("status", "pending")
      .select("id,status")
      .maybeSingle();
    assertDatabaseResult(result.error);
    if (!result.data) throw new AppError("Recommendation not found or already resolved.", 404);
    return result.data;
  }
}
