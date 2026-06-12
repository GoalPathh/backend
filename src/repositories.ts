import { AppError, assertDatabaseResult } from "./errors.js";
import { supabaseAdmin } from "./supabase.js";

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
    const { selectedHabits, ...goal } = input;
    const result = await supabaseAdmin.from("goals").insert({ user_id:userId,title:goal.title,category:goal.category,period:goal.period,progress:goal.progress,start_date:goal.startDate,target_date:goal.targetDate,reminder_enabled:goal.reminderEnabled,notification_preference:goal.notificationPreference }).select("id").single();
    assertDatabaseResult(result.error);
    const habits = selectedHabits.map((habit: any) => ({ goal_id:result.data!.id,user_id:userId,title:habit.title,duration:habit.duration,difficulty:habit.difficulty,time_range:habit.schedule.timeRange,reminder_time:habit.schedule.reminderTime||null,active_days:habit.schedule.activeDays,priority:habit.schedule.priority }));
    const habitResult = await supabaseAdmin.from("habits").insert(habits); assertDatabaseResult(habitResult.error);
    return this.find(userId, result.data!.id);
  }
  async update(userId: string, id: string, input: any) {
    const payload: Record<string, unknown> = {}; const map: Record<string,string> = {title:"title",category:"category",period:"period",progress:"progress",startDate:"start_date",targetDate:"target_date",reminderEnabled:"reminder_enabled",notificationPreference:"notification_preference"};
    for (const [key,column] of Object.entries(map)) if (input[key] !== undefined) payload[column] = input[key];
    payload.updated_at = new Date().toISOString();
    const result = await supabaseAdmin.from("goals").update(payload).eq("user_id", userId).eq("id", id); assertDatabaseResult(result.error);
    return this.find(userId, id);
  }
  async remove(userId: string, id: string) { const result = await supabaseAdmin.from("goals").delete().eq("user_id", userId).eq("id", id); assertDatabaseResult(result.error); }
}

export class UserRepository {
  async profile(userId:string) { const result=await supabaseAdmin.from("profiles").select("*").eq("id",userId).single(); assertDatabaseResult(result.error); return result.data; }
  async updateProfile(userId:string,input:any) { const result=await supabaseAdmin.from("profiles").update({...(input.name!==undefined&&{name:input.name}),...(input.username!==undefined&&{username:input.username}),...(input.avatarUrl!==undefined&&{avatar_url:input.avatarUrl}),updated_at:new Date().toISOString()}).eq("id",userId).select("*").single(); assertDatabaseResult(result.error); return result.data; }
  async preferences(userId:string) { const result=await supabaseAdmin.from("user_preferences").select("*").eq("user_id",userId).single(); assertDatabaseResult(result.error); return result.data; }
  async updatePreferences(userId:string,input:any) { const result=await supabaseAdmin.from("user_preferences").upsert({user_id:userId,...(input.appearance!==undefined&&{appearance:input.appearance}),...(input.notifications!==undefined&&{notifications:input.notifications}),updated_at:new Date().toISOString()}).select("*").single(); assertDatabaseResult(result.error); return result.data; }
}

export class DashboardRepository {
  async today(userId: string) {
    const goals = await new GoalRepository().list(userId);
    const today = new Date().toISOString().slice(0, 10);
    const completions = await supabaseAdmin.from("habit_completions").select("habit_id,completed").eq("user_id", userId).eq("completion_date", today);
    assertDatabaseResult(completions.error);
    return { date: today, goals, completions: completions.data ?? [] };
  }

  async progress(userId: string) {
    const goals = await new GoalRepository().list(userId);
    const completions = await supabaseAdmin.from("habit_completions").select("habit_id,completion_date,completed").eq("user_id", userId).order("completion_date", { ascending: false }).limit(365);
    assertDatabaseResult(completions.error);
    const completed = (completions.data ?? []).filter((item) => item.completed).length;
    const habitCount = goals.reduce((sum: number, goal: any) => sum + (goal.habits?.length ?? 0), 0);
    return {
      stats: { activeGoals: goals.length, habitsCompleted: completed, totalHabits: habitCount },
      goals,
      completions: completions.data ?? [],
    };
  }
}

export class CoachRepository {
  async sessions(userId: string) {
    const result = await supabaseAdmin.from("coach_sessions").select("id,title,created_at,updated_at").eq("user_id", userId).order("updated_at", { ascending: false });
    assertDatabaseResult(result.error); return result.data ?? [];
  }
  async createSession(userId: string, title = "New Session") {
    const result = await supabaseAdmin.from("coach_sessions").insert({ user_id: userId, title }).select("*").single();
    assertDatabaseResult(result.error); return result.data;
  }
  async messages(userId: string, sessionId: string) {
    const result = await supabaseAdmin.from("coach_messages").select("id,role,content,created_at").eq("user_id", userId).eq("session_id", sessionId).order("created_at");
    assertDatabaseResult(result.error); return result.data ?? [];
  }
  async addMessage(userId: string, sessionId: string, role: string, content: string) {
    const result = await supabaseAdmin.from("coach_messages").insert({ user_id:userId,session_id:sessionId,role,content }).select("*").single();
    assertDatabaseResult(result.error);
    await supabaseAdmin.from("coach_sessions").update({ updated_at: new Date().toISOString() }).eq("id", sessionId).eq("user_id", userId);
    return result.data;
  }
}
