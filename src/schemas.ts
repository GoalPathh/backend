import { z } from "zod";

export const authSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
export const registerSchema = authSchema.extend({ name: z.string().min(2).max(80) });
export const habitSchema = z.object({
  id: z.string().optional(), title: z.string().min(1).max(120), duration: z.number().int().min(1).max(1440),
  difficulty: z.enum(["easy", "medium", "hard"]),
  schedule: z.object({ timeRange: z.enum(["anytime", "morning", "afternoon", "evening"]), reminderTime: z.string().optional(), activeDays: z.array(z.string()), priority: z.enum(["low", "medium", "high"]) }),
  createdAt: z.string().optional(),
});
export const goalSchema = z.object({
  title: z.string().min(2).max(160), category: z.enum(["language", "fitness", "skills", "creativity", "learning", "other"]).default("other"),
  period: z.enum(["1month", "3months", "6months", "1year"]), progress: z.number().min(0).max(100).default(0),
  selectedHabits: z.array(habitSchema).min(1), startDate: z.string().datetime(), targetDate: z.string().datetime(),
  reminderEnabled: z.boolean(), notificationPreference: z.enum(["all", "important", "none"]),
});
export const updateGoalSchema = goalSchema.partial().omit({ selectedHabits: true });
export const profileSchema = z.object({ name: z.string().min(2).max(80).optional(), username: z.string().min(2).max(40).optional(), avatarUrl: z.string().url().optional() });
export const preferencesSchema = z.object({
  appearance: z.enum(["light", "dark", "system"]).optional(),
  notifications: z.array(z.object({ id: z.string(), title: z.string(), enabled: z.boolean(), description: z.string() })).optional(),
});
