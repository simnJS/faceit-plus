// Détection de comptes anormaux (« smurfs »), volontairement FACTUELLE : on ne
// pose pas d'étiquette définitive, on signale une combinaison de chiffres
// inhabituelle et on affiche ces chiffres.
//
// Le signal décisif n'est PAS le niveau bas en lui-même (un level 1 à 0.5 de K/D
// est simplement un débutant), mais l'ÉCART entre le niveau affiché et la
// performance réelle : un compte qui domine très au-dessus de ce que son niveau
// laisse attendre, surtout s'il est récent et peu joué.

import type { PlayerAnalysis } from './analysis-cache';
import type { RecentForm } from './faceit-api';

export interface SmurfResult {
  flagged: boolean;
  score: number; // 0-100, indicatif
  ageDays: number | null;
  matches: number;
  winrate: number;
  kd: number;
  hs: number;
  /** Écart entre le K/D réel et celui attendu au niveau du joueur. */
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

/** K/D typique par niveau FACEIT (le matchmaking équilibre autour de 1). */
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

  // Performance de référence : la forme récente prime si l'échantillon suffit,
  // car un smurf « réchauffe » un compte dont le lifetime est encore neutre.
  const effectiveKd = recent && recent.games >= 15 ? Math.max(kd, recent.kd) : kd;
  const expected = skillLevel != null ? EXPECTED_KD[skillLevel] : undefined;
  const kdGap = expected != null ? effectiveKd - expected : null;

  let score = 0;

  // 1) Surperformance par rapport au niveau affiché — le signal le plus parlant.
  if (kdGap != null) {
    if (kdGap >= 0.4) score += 40;
    else if (kdGap >= 0.25) score += 28;
    else if (kdGap >= 0.15) score += 14;
  }

  // 2) Domination brute
  if (winrate >= 65) score += 25;
  else if (winrate >= 60) score += 16;
  else if (winrate >= 55) score += 6;

  // 3) Compte neuf / peu joué
  if (matches < 50) score += 20;
  else if (matches < 100) score += 12;
  else if (matches < 200) score += 4;

  if (ageDays != null) {
    if (ageDays < 60) score += 18;
    else if (ageDays < 180) score += 8;
  }

  // 4) Précision anormale
  if (hs >= 60) score += 10;
  else if (hs >= 50) score += 4;

  // 5) Montée en flèche : la forme récente dépasse nettement le lifetime.
  if (recent && recent.games >= 15 && recent.kd - kd >= 0.3) score += 12;

  // Un vétéran très fort n'est pas un smurf : il faut soit un compte peu joué,
  // soit une performance franchement décorrélée du niveau affiché.
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
