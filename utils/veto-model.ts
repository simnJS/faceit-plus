// Embedded veto model: predicts the next ban, infers the map that will be
// played, and recommends the ban that maximizes our odds.
//
// Weights are trained offline (see crawler/) and embedded as-is — a few
// hundred bytes, no server, no data ever leaves the browser.
//
// WARNING: the order and scale of the features must stay strictly identical
// to crawler/lib/model.mjs, otherwise the weights become meaningless. Any
// change must be made on both sides.

export interface VetoModel {
  version: number;
  maps: string[];
  weights: number[];
  /** Average ban frequency per map, across all players. */
  globalRate: Record<string, number>;
}

/** A team's track record on a map: winrate as a fraction (0-1), and games played. */
export interface MapRecord {
  winrate: number | null;
  games: number;
}

export interface DecisionContext {
  remaining: string[];
  /** Veto turn number, starting at 0. */
  step: number;
  /** Records for the banning team, by map. */
  banner: Map<string, MapRecord>;
  /** Records for the opposing team, by map. */
  opponent: Map<string, MapRecord>;
  /**
   * Ban habit of the captain playing this turn: proportion of times they ban
   * each map when it's available (same definition as at training time).
   * Absent if the captain is unknown.
   */
  captainRate?: Map<string, number> | null;
}

const CAPTAIN_RATE_BASELINE = 0.15;
/** Weight of the prior in the habit smoothing: identical to training time. */
const CAPTAIN_PRIOR_WEIGHT = 8;

/**
 * A captain's ban habit, smoothed toward the global average when the sample
 * is small — same formula as at training time, otherwise the learned weights
 * would not apply at the right scale.
 */
export function captainRatesFromCounts(
  model: VetoModel,
  counts: Record<string, { drops: number; opportunities: number }> | undefined,
  maps: string[],
): Map<string, number> | null {
  if (!counts) return null;
  const rates = new Map<string, number>();
  for (const map of maps) {
    const prior = model.globalRate[map] ?? CAPTAIN_RATE_BASELINE;
    const entry = counts[map];
    const drops = entry?.drops ?? 0;
    const opportunities = entry?.opportunities ?? 0;
    rates.set(
      map,
      (drops + CAPTAIN_PRIOR_WEIGHT * prior) / (opportunities + CAPTAIN_PRIOR_WEIGHT),
    );
  }
  return rates;
}

/** Reproduces the exact training-time feature vector. */
function features(model: VetoModel, context: DecisionContext, map: string): number[] {
  const x = new Array<number>(model.maps.length + 8).fill(0);
  const index = model.maps.indexOf(map);
  if (index >= 0) x[index] = 1;

  const base = model.maps.length;
  const banner = context.banner.get(map);
  const opponent = context.opponent.get(map);
  const wrBanner = banner?.winrate ?? null;
  const wrOpponent = opponent?.winrate ?? null;
  const games = banner?.games ?? 0;

  x[base + 0] = wrBanner == null ? 0 : wrBanner - 0.5;
  x[base + 1] = wrOpponent == null ? 0 : wrOpponent - 0.5;
  x[base + 2] = wrBanner == null || wrOpponent == null ? 0 : wrOpponent - wrBanner;
  x[base + 3] = Math.min(1, Math.log1p(games) / 4);
  x[base + 4] = wrBanner == null ? 0 : 1;
  const captain = context.captainRate?.get(map) ?? model.globalRate[map] ?? CAPTAIN_RATE_BASELINE;
  x[base + 5] = captain - CAPTAIN_RATE_BASELINE;
  x[base + 6] = (model.globalRate[map] ?? CAPTAIN_RATE_BASELINE) - CAPTAIN_RATE_BASELINE;
  x[base + 7] = context.step / 6;
  return x;
}

/** Probability that each remaining map is the next one banned. */
export function predictBan(
  model: VetoModel,
  context: DecisionContext,
  remaining = context.remaining,
): Map<string, number> {
  const scores = remaining.map((map) => {
    const x = features(model, { ...context, remaining }, map);
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += model.weights[i] * x[i];
    return sum;
  });
  const max = Math.max(...scores);
  const exp = scores.map((s) => Math.exp(s - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return new Map(remaining.map((map, i) => [map, exp[i] / total]));
}

export interface VetoState {
  /** Maps still in play, in pool order. */
  remaining: string[];
  /** Records per team, indexed by map. */
  ours: Map<string, MapRecord>;
  theirs: Map<string, MapRecord>;
  /** Opposing captain's habits (ours is assumed to follow the advice). */
  theirCaptainRate?: Map<string, number> | null;
  /** True if it's our turn to ban now. */
  ourTurn: boolean;
  /** Number of bans already made, used to locate the current turn. */
  step: number;
}

/**
 * EXACT distribution of the final map, via subset enumeration.
 * Since the pool never exceeds 8 maps, there are at most 256 states: no need
 * to sample, we can enumerate them all.
 */
export function finalMapDistribution(model: VetoModel, state: VetoState): Map<string, number> {
  const pool = state.remaining;
  const n = pool.length;
  if (n === 0) return new Map();
  if (n === 1) return new Map([[pool[0], 1]]);

  const bit = new Map(pool.map((map, i) => [map, 1 << i]));
  const reach = new Float64Array(1 << n);
  reach[(1 << n) - 1] = 1;

  const popcount = (value: number) => {
    let count = 0;
    let v = value;
    while (v) {
      v &= v - 1;
      count += 1;
    }
    return count;
  };
  const masks = [...Array(1 << n).keys()]
    .filter((m) => m > 0)
    .sort((a, b) => popcount(b) - popcount(a));

  for (const mask of masks) {
    const probability = reach[mask];
    if (probability <= 0) continue;
    const remaining = pool.filter((_, i) => mask & (1 << i));
    if (remaining.length <= 1) continue;

    const banned = n - remaining.length; // bans already simulated in this branch
    const ourTurn = banned % 2 === 0 ? state.ourTurn : !state.ourTurn;
    const distribution = predictBan(
      model,
      {
        remaining,
        step: state.step + banned,
        banner: ourTurn ? state.ours : state.theirs,
        opponent: ourTurn ? state.theirs : state.ours,
        captainRate: ourTurn ? null : state.theirCaptainRate,
      },
      remaining,
    );
    for (const [map, p] of distribution) {
      reach[mask & ~bit.get(map)!] += probability * p;
    }
  }

  const result = new Map<string, number>();
  for (let i = 0; i < n; i++) if (reach[1 << i] > 0) result.set(pool[i], reach[1 << i]);
  return result;
}

export interface BanRecommendation {
  map: string;
  /** Expected value if we ban this map (expected winrate delta). */
  value: number;
  /** Gain over the worst possible choice, in winrate points. */
  gain: number;
  /** Most likely map to be played if we ban this one. */
  likelyMap: string | null;
  likelyProbability: number;
}

/** Value of a map for us: the gap between our winrate and theirs. */
function mapValue(state: VetoState, map: string): number {
  const ours = state.ours.get(map)?.winrate;
  const theirs = state.theirs.get(map)?.winrate;
  if (ours == null && theirs == null) return 0;
  return (ours ?? 0.5) - (theirs ?? 0.5);
}

/**
 * Recommends the ban that maximizes our win expectancy.
 *
 * For each candidate map, we assume we ban it, roll out the rest of the veto
 * with the model, and weight each possible outcome by the advantage it gives
 * us. This is more nuanced than a one-shot heuristic: banning a map the
 * opponent would have banned anyway yields nothing, and the calculation
 * reflects that.
 */
export function recommendBans(model: VetoModel, state: VetoState): BanRecommendation[] {
  if (state.remaining.length <= 1) return [];

  const recommendations: BanRecommendation[] = [];
  for (const candidate of state.remaining) {
    const remaining = state.remaining.filter((m) => m !== candidate);
    const outcome =
      remaining.length === 1
        ? new Map([[remaining[0], 1]])
        : finalMapDistribution(model, {
            ...state,
            remaining,
            step: state.step + 1,
            ourTurn: !state.ourTurn, // it's the opponent's turn next
          });

    let value = 0;
    let likelyMap: string | null = null;
    let likelyProbability = 0;
    for (const [map, probability] of outcome) {
      value += probability * mapValue(state, map);
      if (probability > likelyProbability) {
        likelyProbability = probability;
        likelyMap = map;
      }
    }
    recommendations.push({ map: candidate, value, gain: 0, likelyMap, likelyProbability });
  }

  recommendations.sort((a, b) => b.value - a.value);
  const worst = recommendations[recommendations.length - 1]?.value ?? 0;
  for (const item of recommendations) item.gain = item.value - worst;
  return recommendations;
}
