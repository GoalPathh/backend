/**
 * Subscription DTOs and plan matrix.
 * Mirrored in `frontend/lib/types.ts` so both sides speak the same shape.
 */

export type SubscriptionTier = "free" | "premium";
export type SubscriptionStatus = "pending" | "active" | "expired" | "cancelled";

/**
 * Numeric limits for the free tier. Premium uses `null` (meaning unlimited).
 * `coachMessagesPerDay` used to live here as a hardcoded free cap (=10) but
 * was migrated to a tier-percentage system (`COACH_TIER_ACCESS_PERCENTAGE`).
 * Goals/habits are still asymmetric (free = hard cap, premium = unlimited)
 * because those count toward product surface area, not LLM cost.
 */
export const FREE_LIMITS = {
  goals: 3,
  habitsPerGoal: 5,
} as const;

/** ─── Coach access pricing ───────────────────────────────────────────────
 * Both tiers now have a CONCRETE per-day cap (Fair Use Policy). The cap is
 * derived from a single `COACH_BASELINE_MESSAGES_PER_DAY` (representing
 * "100% Premium access") multiplied by a per-tier percentage. To raise the
 * ceiling for everyone, edit the baseline; to widen the gap between tiers,
 * adjust `COACH_TIER_ACCESS_PERCENTAGE`.
 */
export const COACH_BASELINE_MESSAGES_PER_DAY = 50;
export const COACH_TIER_ACCESS_PERCENTAGE: Record<SubscriptionTier, number> = {
  free: 0.10,
  premium: 1.0,
};

export interface CoachAccessRule {
  /** concrete upper bound enforced per UTC day */
  maxMessagesPerDay: number;
  /** the percentage of baseline this tier enjoys (10, 50, 100, ...) */
  accessPercentage: number;
}

/**
 * Resolve the coach access policy for a given tier. The math is:
 *
 *     maxMessagesPerDay    = round(baseline × tierPercentage)
 *     accessPercentage     = round(tierPercentage × 100)
 *
 * Both tiers return CONCRETE numbers now (premium is no longer `null`) so
 * the assert at message-send time, the quota badge UI, and the marketing
 * copy stay numerically consistent — and there's a single knob to tune.
 */
export function resolveCoachAccess(tier: SubscriptionTier): CoachAccessRule {
  const pct = COACH_TIER_ACCESS_PERCENTAGE[tier];
  return {
    maxMessagesPerDay: Math.round(COACH_BASELINE_MESSAGES_PER_DAY * pct),
    accessPercentage: Math.round(pct * 100),
  };
}

export interface SubscriptionLimits {
  /** max active goals; null = unlimited */
  maxGoals: number | null;
  /** max habits per single goal; null = unlimited */
  maxHabitsPerGoal: number | null;
  /** max user->coach messages per user per UTC day (Fair Use Policy; never null) */
  maxCoachMessagesPerDay: number;
  /** the percentage of the coach baseline this tier enjoys (10 | 100) */
  coachAccessPercentage: number;
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
      ...resolveCoachAccess("free"),
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
      ...resolveCoachAccess("premium"),
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
