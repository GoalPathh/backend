import { z } from "zod";

export const authSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
export const registerSchema = authSchema.extend({ name: z.string().min(2).max(80) });
export const refreshSessionSchema = z.object({ refreshToken: z.string().min(1) });
export const forgotPasswordSchema = z.object({ email: z.string().email() });
export const updatePasswordSchema = z.object({ password: z.string().min(8) });
export const oauthSchema = z.object({
  next: z.string().regex(/^\/(?!\/)/, "Next path must be an internal path.").default("/today"),
});
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
export const completionSchema = z.object({ completed: z.boolean(), completionDate: z.string().date().optional() });
export const coachSessionUpdateSchema = z.object({ title: z.string().min(1).max(120) });

// ── Interactive Goal Wizard payload (sent when chat message is tagged [goal_finalized]) ──
// All fields optional on the SCHEMA side so we can give the user a clear error
// instead of a generic 400. The route handler enforces required fields explicitly.
export const wizardHabitSchema = z.object({
  title: z.string().min(1).max(120),
  difficulty: z.enum(["easy", "medium", "hard"]),
  duration_minutes: z.number().int().min(1).max(1440),
});

export const wizardGoalPayloadSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  category: z.enum(["language", "fitness", "skills", "creativity", "learning", "other"]).optional(),
  duration: z.enum(["1month", "3months", "6months", "1year"]).optional(),
  habits: z.array(wizardHabitSchema).max(5).optional().default([]),
  schedule: z.object({
    activeDays: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).max(7).optional().default([]),
    reminderTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }).optional(),
  notifications: z.enum(["all", "important", "none"]).optional().default("all"),
  milestones: z.array(
    z.object({
      title: z.string().min(3).max(200),
      target_date: z.string().datetime().optional(),
      sort_order: z.number().int().min(0).max(20).optional(),
    })
  ).max(12).optional(),
}).passthrough();

export const GOAL_WIZARD_TAG = "[goal_finalized]";

// ── Persona query params ──
export const personaWindowDaysSchema = z.coerce.number().int().refine(
  (n) => [7, 14, 30].includes(n),
  { message: "windowDays must be one of 7, 14, 30" }
).default(14);
