/**
 * Subscription DTOs and plan matrix.
 * Mirrored in `frontend/lib/types.ts` so both sides speak the same shape.
 */

export type SubscriptionTier = "free" | "premium";
export type SubscriptionStatus = "pending" | "active" | "expired" | "cancelled";

/** Numeric limits for the free tier. Premium uses `null` (meaning unlimited). */
export const FREE_LIMITS = {
  goals: 3,
  habitsPerGoal: 5,
  coachMessagesPerDay: 10,
} as const;

export interface SubscriptionLimits {
  /** max active goals; null = unlimited */
  maxGoals: number | null;
  /** max habits per single goal; null = unlimited */
  maxHabitsPerGoal: number | null;
  /** max user->coach messages per user per UTC day; null = unlimited */
  maxCoachMessagesPerDay: number | null;
}

export interface PlanFeatures {
  unlimitedGoals: boolean;
  unlimitedHabits: boolean;
  fullAiCoachAccess: boolean;
  aiAdaptiveHabit: boolean;
  futureSelfSimulation: boolean;
  prioritySupport: boolean;
  advancedInsight: boolean;
}

export interface SubscriptionResponse {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  /** resolved limits driven by current effective tier */
  limits: SubscriptionLimits;
  /** resolved features driven by current effective tier */
  features: PlanFeatures;
  /** monthly price in IDR */
  premiumPriceIdr: number;
  /** days in one billing period */
  premiumPeriodDays: number;
}

export const PLAN_MATRIX: Record<SubscriptionTier, { limits: SubscriptionLimits; features: PlanFeatures }> = {
  free: {
    limits: {
      maxGoals: FREE_LIMITS.goals,
      maxHabitsPerGoal: FREE_LIMITS.habitsPerGoal,
      maxCoachMessagesPerDay: FREE_LIMITS.coachMessagesPerDay,
    },
    features: {
      unlimitedGoals: false,
      unlimitedHabits: false,
      fullAiCoachAccess: false,
      aiAdaptiveHabit: false,
      futureSelfSimulation: false,
      prioritySupport: false,
      advancedInsight: false,
    },
  },
  premium: {
    limits: {
      maxGoals: null,
      maxHabitsPerGoal: null,
      maxCoachMessagesPerDay: null,
    },
    features: {
      unlimitedGoals: true,
      unlimitedHabits: true,
      fullAiCoachAccess: true,
      aiAdaptiveHabit: true,
      futureSelfSimulation: true,
      prioritySupport: true,
      advancedInsight: true,
    },
  },
};

/** Premium feature keys. Frontend uses these as feature flags. */
export const PREMIUM_FEATURE_KEYS = [
  "ai_adaptive_habit",
  "future_self_simulation",
  "priority_support",
  "advanced_insight",
] as const;
export type PremiumFeatureKey = (typeof PREMIUM_FEATURE_KEYS)[number];
