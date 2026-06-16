import { AppError, assertDatabaseResult } from "./errors.js";
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
}

export class UserRepository {
  async profile(userId:string) { const result=await supabaseAdmin.from("profiles").select("*").eq("id",userId).single(); assertDatabaseResult(result.error); return result.data; }
  async updateProfile(userId:string,input:any) { const result=await supabaseAdmin.from("profiles").update({...(input.name!==undefined&&{name:input.name}),...(input.username!==undefined&&{username:input.username}),...(input.avatarUrl!==undefined&&{avatar_url:input.avatarUrl}),updated_at:new Date().toISOString()}).eq("id",userId).select("*").single(); assertDatabaseResult(result.error); return result.data; }
  async preferences(userId:string) { const result=await supabaseAdmin.from("user_preferences").select("*").eq("user_id",userId).single(); assertDatabaseResult(result.error); return result.data; }
  async updatePreferences(userId:string,input:any) { const result=await supabaseAdmin.from("user_preferences").upsert({user_id:userId,...(input.appearance!==undefined&&{appearance:input.appearance}),...(input.notifications!==undefined&&{notifications:input.notifications}),updated_at:new Date().toISOString()}).select("*").single(); assertDatabaseResult(result.error); return result.data; }
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
      const pace = g.progress >= 100 ? "On Track"
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
    const result = await supabaseAdmin.from("habit_completions").upsert({
      habit_id: habitId,
      user_id: userId,
      completion_date: completionDate ?? new Date().toISOString().slice(0, 10),
      completed,
      completed_at: new Date().toISOString(),
    }, { onConflict: "habit_id,completion_date" }).select("*").single();
    assertDatabaseResult(result.error);

    // Auto-recompute parent goal.progress (also fires SQL trigger on deployed env)
    if (habit.data.goal_id) {
      try {
        await this.recomputeGoalProgress(userId, habit.data.goal_id);
      } catch (e) {
        console.error("[Dashboard] recompute fallback failed:", (e as Error).message);
        // Non-fatal — completion saved successfully
      }
    }

    return result.data;
  }

  async today(userId: string) {
    const goals = await new GoalRepository().list(userId);
    const today = new Date().toISOString().slice(0, 10);
    const completions = await supabaseAdmin.from("habit_completions").select("habit_id,completed").eq("user_id", userId).eq("completion_date", today);
    assertDatabaseResult(completions.error);
    return { date: today, goals, completions: completions.data ?? [] };
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

