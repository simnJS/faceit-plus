// Estimates a player's role from their FACEIT lifetime stats.
// Formula replicated from Mappio v4.4.6 (function `So`): 5 roles scored 0-100
// (sniper, entry, support, clutcher, anchor), plus "carry" (composite),
// "rifler" (default) and "unknown" (fewer than 20 matches).
//
// Lifetime fields used (all fractions 0..1 except m*, verified against real data):
//   m1  = matches            k19 = entry rate            k18 = entry success rate
//   k20 = 1v1 winrate        k21 = 1v2 winrate           m26 = number of 1v1s
//   m28 = number of 1v2s     k27 = utility success rate  k28 = utility per round
//   k23 = flash success rate                              k29 = sniper kill rate

import { statNumber, type RawStatRecord } from './faceit-api';

export type ScoredRole = 'sniper' | 'entry' | 'support' | 'clutcher' | 'anchor';
export type Role = ScoredRole | 'carry' | 'rifler' | 'unknown';

export type RoleScores = Record<ScoredRole, number>;

export interface RoleResult {
  role: Role;
  scores: RoleScores;
}

/** Evaluation order (breaks ties: the first one wins). */
export const SCORED_ROLES: ScoredRole[] = ['sniper', 'entry', 'support', 'clutcher', 'anchor'];

export const ROLE_GRADIENT: Record<Role, string> = {
  sniper: 'linear-gradient(30deg,#A855F7,#EC4899)',
  entry: 'linear-gradient(30deg,#f97316,#ef4444)',
  support: 'linear-gradient(30deg,#06b6d4,#3b82f6)',
  clutcher: 'linear-gradient(30deg,#8E2DE2,#A855F7)',
  anchor: 'linear-gradient(30deg,#22C55E,#10B981)',
  carry: 'linear-gradient(30deg,#eab308,#f59e0b)',
  rifler: 'linear-gradient(30deg,#396AFC,#2948FF)',
  unknown: 'linear-gradient(30deg,#4b5563,#374151)',
};

/** Gradient endpoints, used to tint SVGs and numbers. */
export const ROLE_STOPS: Record<Role, [string, string]> = {
  sniper: ['#A855F7', '#EC4899'],
  entry: ['#f97316', '#ef4444'],
  support: ['#06b6d4', '#3b82f6'],
  clutcher: ['#8E2DE2', '#A855F7'],
  anchor: ['#22C55E', '#10B981'],
  carry: ['#eab308', '#f59e0b'],
  rifler: ['#396AFC', '#2948FF'],
  unknown: ['#4b5563', '#374151'],
};

const MIN_MATCHES = 20;

// Mappio formula constants
const ENTRY_RATE_LOW = 0.15;
const ENTRY_RATE_HIGH = 0.26;
const ANCHOR_DELTA_LOW = -0.067;
const ANCHOR_DELTA_HIGH = 0.0708;
const CLUTCH_1V1_MEAN = 0.3788;
const CLUTCH_1V1_SD = 0.068;
const CLUTCH_1V2_MEAN = 0.2178;
const CLUTCH_1V2_SD = 0.059;

/** Sniper rate → score curve. */
const SNIPER_CURVE: Array<[rate: number, score: number]> = [
  [0, 0],
  [0.01, 10],
  [0.03, 18],
  [0.06, 25],
  [0.1, 50],
  [0.17, 90],
  [0.22, 95],
  [0.23, 96],
  [0.25, 97],
  [0.28, 98],
  [0.32, 99],
  [0.37, 99.5],
  [0.47, 100],
];

// Percentile tables (percentile → threshold)
const UTILITY_PERCENTILES: Record<number, number> = {
  10: 0.056,
  25: 0.081,
  50: 0.112,
  75: 0.15,
  90: 0.194,
  95: 0.227,
  99: 0.306,
};
const FLASH_PERCENTILES: Record<number, number> = {
  10: 0.4,
  25: 0.45,
  50: 0.49,
  75: 0.54,
  90: 0.59,
  95: 0.62,
  99: 0.71,
};

const clamp01 = (value: number, lo: number, hi: number) =>
  Math.max(0, Math.min(1, (value - lo) / (hi - lo)));

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

/** Interpolated percentile of a value within a {percentile: threshold} table. */
function percentile(value: number, table: Record<number, number>): number {
  const points = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (value <= table[p]) {
      if (i === 0) return 0;
      const prev = points[i - 1];
      const prevValue = table[prev];
      return ((value - prevValue) / (table[p] - prevValue)) * (p - prev) + prev;
    }
  }
  return 100;
}

function sniperScore(rate: number): number {
  if (rate <= 0) return 0;
  const last = SNIPER_CURVE[SNIPER_CURVE.length - 1];
  if (rate >= last[0]) return 100;
  for (let i = 1; i < SNIPER_CURVE.length; i++) {
    const [highRate, highScore] = SNIPER_CURVE[i];
    if (rate <= highRate) {
      const [lowRate, lowScore] = SNIPER_CURVE[i - 1];
      const f = (rate - lowRate) / (highRate - lowRate);
      return Math.round(lowScore + f * (highScore - lowScore));
    }
  }
  return 100;
}

const EMPTY_SCORES: RoleScores = { sniper: 0, entry: 0, support: 0, clutcher: 0, anchor: 0 };

/** Computes role scores and the resulting role from the raw lifetime stats object. */
export function scoreRoles(lifetime: RawStatRecord | null | undefined): RoleResult {
  if (!lifetime) return { role: 'unknown', scores: { ...EMPTY_SCORES } };

  const num = (key: string) => statNumber(lifetime, key) ?? 0;
  const matches = num('m1');
  if (matches < MIN_MATCHES) return { role: 'unknown', scores: { ...EMPTY_SCORES } };

  const entryRate = num('k19');
  const entrySuccess = num('k18');
  const clutch1v1 = num('k20');
  const clutch1v2 = num('k21');
  const attempts1v1 = num('m26');
  const attempts1v2 = num('m28');
  const utilitySuccess = num('k27');
  const utilityUsage = num('k28');
  const flashSuccess = num('k23');
  const sniperRate = num('k29');

  // SNIPER - based on the sniper kill rate curve
  const sniper = sniperScore(sniperRate);

  // ENTRY - 60% entry volume + 40% entry overperformance
  const expectedEntry = 0.473 + 0.175 * entryRate;
  const entryDelta = entrySuccess - expectedEntry;
  const entry = clampScore(
    100 *
      (0.6 * clamp01(entryRate, ENTRY_RATE_LOW, ENTRY_RATE_HIGH) +
        0.4 * clamp01(entryDelta, -0.07, 0.07)),
  );

  // SUPPORT - 60% effective utility per round + 40% successful flashes
  const support = clampScore(
    0.6 * percentile(utilityUsage * utilitySuccess, UTILITY_PERCENTILES) +
      0.4 * percentile(flashSuccess, FLASH_PERCENTILES),
  );

  // CLUTCHER - 1v1/1v2 z-scores shrunk toward the league mean (priors 30 and 20)
  const shrunk1v1 = (attempts1v1 * clutch1v1 + 30 * CLUTCH_1V1_MEAN) / (attempts1v1 + 30);
  const shrunk1v2 = (attempts1v2 * clutch1v2 + 20 * CLUTCH_1V2_MEAN) / (attempts1v2 + 20);
  const z1v1 = (shrunk1v1 - CLUTCH_1V1_MEAN) / CLUTCH_1V1_SD;
  const z1v2 = (shrunk1v2 - CLUTCH_1V2_MEAN) / CLUTCH_1V2_SD;
  const clutcher = clampScore(0.45 * (50 + 40 * z1v1) + 0.55 * (50 + 40 * z1v2));

  // ANCHOR - 50% low entry rate (inverse ramp) + 50% overperformance
  const expectedAnchor = 0.457993 + 0.243934 * entryRate;
  const anchorDelta = entrySuccess - expectedAnchor;
  const lowEntry =
    entryRate <= ENTRY_RATE_LOW
      ? 1
      : entryRate >= ENTRY_RATE_HIGH
        ? 0
        : (entryRate - ENTRY_RATE_HIGH) / (ENTRY_RATE_LOW - ENTRY_RATE_HIGH);
  const anchorPerf = clamp01(anchorDelta, ANCHOR_DELTA_LOW, ANCHOR_DELTA_HIGH);
  const anchor = clampScore(100 * (0.5 * lowEntry + 0.5 * anchorPerf));

  const scores: RoleScores = { sniper, entry, support, clutcher, anchor };

  if (sniper >= 80) return { role: 'sniper', scores };
  if (clutcher >= 80 && entry >= 80) return { role: 'carry', scores };

  let best: ScoredRole = 'sniper';
  for (const role of SCORED_ROLES) {
    if (scores[role] > scores[best]) best = role;
  }
  return { role: scores[best] > 60 ? best : 'rifler', scores };
}

const ICON_PATHS: Record<Role, string> = {
  // scope
  sniper: '<circle cx="12" cy="12" r="7"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5"/>',
  // assault arrow
  entry: '<path d="M3 12h13M11 6l6 6-6 6M20 5v14"/>',
  // grenade / support
  support: '<circle cx="12" cy="13" r="6"/><path d="M12 4v3M9 4h6M17 8l3-3"/>',
  // lightning bolt
  clutcher: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>',
  // anchor
  anchor: '<circle cx="12" cy="4" r="2.5"/><path d="M12 7v14M6 12H4a8 8 0 0 0 16 0h-2"/>',
  // crown
  carry: '<path d="M4 18h16M4 18l-1.2-9L8 13l4-8 4 8 5.2-4-1.2 9z"/>',
  // bullet / rifle
  rifler: '<path d="M3 10h13l4 2-4 2H9l-2 3v-3H3z"/>',
  unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3v1.7M12 17h.01"/>',
};

let iconSeq = 0;

/** Inline SVG for the role icon, its stroke tinted by the role gradient. */
export function roleIconSvg(role: Role, size = 13): string {
  const [from, to] = ROLE_STOPS[role];
  const id = `fp-role-${role}-${(iconSeq += 1)}`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
      stroke="url(#${id})" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      style="display:block;flex:0 0 auto">
      <defs><linearGradient id="${id}" x1="0" y1="24" x2="24" y2="0">
        <stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
      </linearGradient></defs>${ICON_PATHS[role]}</svg>`;
}
