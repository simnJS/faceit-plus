// Detection of abnormal accounts ("smurfs"), deliberately FACTUAL: we don't
// slap a definitive label on the account, we flag an unusual combination of
// numbers and display those numbers.
//
// The deciding signal is NOT the low skill level by itself (a level 1 with a
// 0.5 K/D is simply a beginner), but the GAP between the displayed level and
// the actual performance: an account that dominates well above what its level
// implies, especially if it is recent and lightly played.

import type { PlayerAnalysis } from './analysis-cache';
import type { RecentForm } from './faceit-api';

export interface SmurfResult {
  flagged: boolean;
  score: number; // 0-100, indicative
  ageDays: number | null;
  matches: number;
  winrate: number;
  kd: number;
  hs: number;
  /** Gap between the actual K/D and the K/D expected at the player's level. */
  kdGap: number | null;
  skillLevel: number | null;
  recent: RecentForm | null;
}

export interface PlayerContext {
  skillLevel?: number;
  accountCreatedAt?: number | null;
  recent?: RecentForm | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Typical K/D per FACEIT level (matchmaking balances around 1). */
const EXPECTED_KD: Record<number, number> = {
  1: 0.8,
  2: 0.85,
  3: 0.9,
  4: 0.95,
  5: 1.0,
  6: 1.03,
  7: 1.07,
  8: 1.11,
  9: 1.17,
  10: 1.25,
};

export function computeSmurf(
  analysis: PlayerAnalysis | undefined,
  context: PlayerContext = {},
): SmurfResult | null {
  if (!analysis || analysis.matches <= 0) return null;

  const { matches, winrate, kd, hs } = analysis;
  const { skillLevel, accountCreatedAt, recent } = context;
  const ageDays =
    accountCreatedAt != null
      ? Math.max(0, Math.round((Date.now() - accountCreatedAt) / DAY_MS))
      : null;

  // Reference performance: recent form takes priority once the sample is large
  // enough, because a smurf "warms up" an account whose lifetime stats are
  // still neutral.
  const effectiveKd = recent && recent.games >= 15 ? Math.max(kd, recent.kd) : kd;
  const expected = skillLevel != null ? EXPECTED_KD[skillLevel] : undefined;
  const kdGap = expected != null ? effectiveKd - expected : null;

  let score = 0;

  // 1) Overperformance relative to the displayed level — the strongest signal.
  if (kdGap != null) {
    if (kdGap >= 0.4) score += 40;
    else if (kdGap >= 0.25) score += 28;
    else if (kdGap >= 0.15) score += 14;
  }

  // 2) Raw dominance
  if (winrate >= 65) score += 25;
  else if (winrate >= 60) score += 16;
  else if (winrate >= 55) score += 6;

  // 3) New / lightly played account
  if (matches < 50) score += 20;
  else if (matches < 100) score += 12;
  else if (matches < 200) score += 4;

  if (ageDays != null) {
    if (ageDays < 60) score += 18;
    else if (ageDays < 180) score += 8;
  }

  // 4) Abnormal accuracy
  if (hs >= 60) score += 10;
  else if (hs >= 50) score += 4;

  // 5) Sharp spike: recent form clearly exceeds the lifetime stats.
  if (recent && recent.games >= 15 && recent.kd - kd >= 0.3) score += 12;

  // A very strong veteran is not a smurf: we need either a lightly played
  // account, or a performance clearly decorrelated from the displayed level.
  const flagged = score >= 55 && (matches < 250 || (kdGap ?? 0) >= 0.25);

  return {
    flagged,
    score: Math.min(100, score),
    ageDays,
    matches,
    winrate,
    kd: effectiveKd,
    hs,
    kdGap,
    skillLevel: skillLevel ?? null,
    recent: recent ?? null,
  };
}
