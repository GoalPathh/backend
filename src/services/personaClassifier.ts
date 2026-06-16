/**
 * Pure persona classifier + advice derivation — no DB access.
 * Used by `PersonaRepository` after it has gathered the aggregates.
 */

import type {
  PersonaAdvice,
  PersonaArchetype,
  PersonaEvidence,
  PersonaFeatures,
} from "../dto/persona.js";

const ARCHETYPE_TONE: Record<PersonaArchetype, string> = {
  "Steady Builder":
    "Encouragingly consistent — celebrate the streak, gently nudge for higher difficulty",
  "Comeback Captain":
    "Warm and validating — highlight recovery wins, reduce guilt",
  "Momentum Maker": "Upbeat — ride the momentum, suggest adaptive goals",
  "Streak Hunter": "Tactically rewarding — frame daily actions as streak fuel",
  "Marathon Runner": "Pragmatic and long-view — emphasise compounding progress",
  "GoalPath Apprentice": "Welcoming — start with the easiest possible wins",
};

export const DEFAULT_HEADLINE: Record<PersonaArchetype, string> = {
  "Steady Builder": "Bangun kebiasaanmu dengan ritme yang konsisten.",
  "Comeback Captain": "Kamu bangkit setiap kali terjatuh — itu kekuatan super.",
  "Momentum Maker": "Besok terlihat lebih kuat dari hari ini.",
  "Streak Hunter": "Streak-mu adalah mesin utama goal-mu.",
  "Marathon Runner": "Kamu bermain untuk jangka panjang.",
  "GoalPath Apprentice": "Mulai rutinitas pertamamu untuk membuka profil AI.",
};

export function classifyArchetype(traits: PersonaFeatures): PersonaArchetype {
  const total = traits.consistency + traits.streak_hunter + traits.completionist
    + traits.momentum + traits.recovery;
  if (total < 60) return "GoalPath Apprentice";

  const ranked = ([
    ["consistency", traits.consistency],
    ["streak_hunter", traits.streak_hunter],
    ["completionist", traits.completionist],
    ["momentum", traits.momentum],
    ["recovery", traits.recovery],
  ] as Array<[keyof PersonaFeatures, number]>)
    .sort((a, b) => b[1] - a[1]);

  const topKey = ranked[0]![0] as keyof PersonaFeatures;
  const top2 = ranked[1]![0] as keyof PersonaFeatures;

  if (topKey === "consistency" && top2 === "streak_hunter") return "Steady Builder";
  if (topKey === "recovery" && traits.consistency < 50) return "Comeback Captain";
  if (topKey === "momentum" && traits.consistency > 40) return "Momentum Maker";
  if (topKey === "streak_hunter" && traits.consistency > 40) return "Streak Hunter";
  if (topKey === "completionist") return "Marathon Runner";

  // Top-feature-only fallbacks (try exhaustive)
  const fallback: Record<keyof PersonaFeatures, PersonaArchetype> = {
    consistency: "Steady Builder",
    recovery: "Comeback Captain",
    momentum: "Momentum Maker",
    streak_hunter: "Streak Hunter",
    completionist: "Marathon Runner",
  };
  return fallback[topKey];
}

export function deriveAdvice(
  archetype: PersonaArchetype,
  traits: PersonaFeatures,
  evidence: PersonaEvidence,
): PersonaAdvice {
  let difficulty: PersonaAdvice["difficulty"] = "maintain";
  if (traits.consistency >= 80 && evidence.avgDifficulty === "easy") difficulty = "easier";
  else if (traits.consistency < 40 && evidence.avgDifficulty === "hard") difficulty = "easier";

  const habit: string[] = [];
  if (traits.consistency < 50) habit.push("Kurangi jumlah kebiasaan aktif menjadi 1-2 dulu untuk fokus.");
  if (traits.streak_hunter > 70 && evidence.habitCount > 5) habit.push("Fokus mempertahankan streak; tidak perlu tambah kebiasaan baru.");
  if (traits.recovery > 70) habit.push("Tambahkan buffer day (jadwal fleksibel) untuk mengurangi recoil setelah miss.");
  if (traits.momentum > 60) habit.push("Saat tepat untuk naikkan difficulty satu level dan tangkap momentum.");

  let suggestedMilestone: PersonaAdvice["suggestedMilestone"] = null;
  if (archetype === "Marathon Runner" && traits.recovery >= 70) {
    suggestedMilestone = {
      title: "Pertahankan streak 1 minggu penuh (ringan)",
      reason: "Track record comeback-mu kuat — milestone konsistensi ringan akan memperkuat ritme jangka panjangmu.",
    };
  } else if (archetype === "Streak Hunter" && traits.streak_hunter > 60) {
    suggestedMilestone = {
      title: "Tambah kebiasaan mini harian (5 menit)",
      reason: "Streak-mu sudah kuat — kebiasaan kecil 5 menit akan memperpanjang momentum tanpa menambah beban.",
    };
  } else if (traits.consistency > 50) {
    suggestedMilestone = {
      title: "Tutup 1 milestone aktif minggu ini",
      reason: "Momentum konsistensi dan completion rate-mu mendukung penyelesaian milestone yang sedang berjalan.",
    };
  }

  return {
    tone: ARCHETYPE_TONE[archetype],
    difficulty,
    habit,
    suggestedMilestone,
  };
}
