/**
 * AI Persona — DTO contract. Used by services, Zod validators,
 * and reproduced in `frontend/lib/types.ts` for cross-stack typing.
 */

export interface PersonaFeatures {
  consistency: number;     // 0..100 — done days vs expected
  recovery: number;         // 0..100 — comeback odds after streak break
  completionist: number;    // 0..100 — %milestones completed
  streak_hunter: number;    // 0..100 — longest streak normalised at 30d
  momentum: number;         // 0..100 — week-over-week completion delta
}

export type PersonaArchetype =
  | "Steady Builder"
  | "Comeback Captain"
  | "Momentum Maker"
  | "Streak Hunter"
  | "Marathon Runner"
  | "GoalPath Apprentice";

export type DifficultyAdvice = "easier" | "maintain" | "harder";

export interface PersonaEvidence {
  streaksRecovered: number;
  longestStreak: number;
  completedLast7: number;
  missedLast7: number;
  completionRate: number;     // 0..100
  avgDifficulty: "easy" | "medium" | "hard";
  goalCount: number;
  habitCount: number;
  newHabitsLast30: number;
  windowDays: number;
}

export interface PersonaMilestoneSuggestion {
  title: string;
  reason: string;
}

export interface PersonaAdvice {
  tone: string;
  difficulty: DifficultyAdvice;
  habit: string[];
  suggestedMilestone?: PersonaMilestoneSuggestion | null;
}

export interface PersonaResponse {
  archetype: PersonaArchetype;
  headline: string;
  traits: PersonaFeatures;
  evidence: PersonaEvidence;
  advice: PersonaAdvice;
  generatedAt: string;
  windowDays: number;
}
