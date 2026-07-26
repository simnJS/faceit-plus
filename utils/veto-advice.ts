// Veto advice and final map prediction.
//
// Other extensions display raw numbers; this module turns them into a decision:
//   - which map to ban first (biggest opponent advantage, while avoiding "wasting"
//     a ban on a map the enemy captain would ban themselves anyway);
//   - which map is most likely to be played, via Monte Carlo simulation of the
//     remaining veto (our side plays rationally, the opponent follows their
//     historical ban distribution).

import type { PoolMap } from './faceit-api';
import type { TeamMapStat } from './team-map-stats';
import weights from './veto-model-weights.json';
import {
  captainRatesFromCounts,
  finalMapDistribution as modelFinalMap,
  recommendBans,
  type MapRecord,
  type VetoModel,
  type VetoState,
} from './veto-model';

/** Offline-trained weights. `version: 0` means "not yet trained". */
const MODEL = weights as VetoModel;
export const hasTrainedModel = MODEL.version > 0 && MODEL.maps.length > 0;

export interface VetoContext {
  /** Maps still in play, in pool order. */
  pool: PoolMap[];
  /** Winrates of our team and the opponent, keyed by map id. */
  mine: Map<string, TeamMapStat>;
  theirs: Map<string, TeamMapStat>;
  /** Probability (%) that the opposing captain bans each map. */
  banRates: Map<string, number> | null;
  /** Raw veto counts for the opposing captain, used by the model. */
  captainCounts?: Record<string, { drops: number; opportunities: number }> | null;
  /** true if it is our team's turn to ban now. */
  ourTurn?: boolean;
}

/** Converts our team stats to the format expected by the model. */
function toRecords(stats: Map<string, TeamMapStat>, pool: PoolMap[]): Map<string, MapRecord> {
  const records = new Map<string, MapRecord>();
  for (const map of pool) {
    const entry = stats.get(map.id);
    records.set(map.id, {
      // The model works with fractions, the extension stores percentages.
      winrate: entry?.winrate == null ? null : entry.winrate / 100,
      games: entry?.games ?? 0,
    });
  }
  return records;
}

function toModelState(context: VetoContext): VetoState {
  const pool = context.pool;
  return {
    remaining: pool.map((m) => m.id),
    ours: toRecords(context.mine, pool),
    theirs: toRecords(context.theirs, pool),
    theirCaptainRate: captainRatesFromCounts(
      MODEL,
      context.captainCounts ?? undefined,
      pool.map((m) => m.id),
    ),
    ourTurn: context.ourTurn ?? true,
    step: 0,
  };
}

const NEUTRAL_WINRATE = 50;

function winrate(stats: Map<string, TeamMapStat>, mapId: string): number {
  const value = stats.get(mapId)?.winrate;
  return value == null ? NEUTRAL_WINRATE : value;
}

/**
 * Ban priority score: positive means the map favors the opponent.
 * Maps they often ban themselves are discounted (redundant ban).
 */
function banPriority(context: VetoContext, mapId: string): number {
  const advantage = winrate(context.theirs, mapId) - winrate(context.mine, mapId);
  const theirBan = context.banRates?.get(mapId) ?? 0;
  return advantage * (1 - Math.min(theirBan, 60) / 200);
}

export interface BanAdvice {
  mapId: string;
  /** Winrate gap against us on this map, in points. */
  advantage: number;
  /** Expected gain from the ban, in winrate points, when the model is available. */
  gain?: number;
  /** true if the advice comes from the trained model rather than the simple rule. */
  fromModel: boolean;
}

/**
 * Map to ban first.
 *
 * With the trained model: for each candidate, we play out the rest of the veto
 * and weight each outcome by the advantage it gives us. We keep the ban with
 * the best expectation — which in particular avoids wasting a ban on a map the
 * opponent was going to remove themselves.
 *
 * Without a model, we fall back to a one-shot rule: ban wherever the winrate
 * gap is most unfavorable to us.
 */
export function recommendBan(context: VetoContext): BanAdvice | null {
  if (context.pool.length <= 1) return null;

  if (hasTrainedModel) {
    const ranked = recommendBans(MODEL, toModelState(context));
    const best = ranked[0];
    // We always give advice: "which map to ban" has an answer even when the
    // margin is thin. Requiring a minimum gap would mean staying silent in the
    // most common situations, where the pool is balanced.
    if (best) {
      return {
        mapId: best.map,
        advantage: winrate(context.theirs, best.map) - winrate(context.mine, best.map),
        gain: best.gain * 100,
        fromModel: true,
      };
    }
    return null;
  }

  let best: { mapId: string; advantage: number; score: number } | null = null;
  for (const map of context.pool) {
    const score = banPriority(context, map.id);
    const advantage = winrate(context.theirs, map.id) - winrate(context.mine, map.id);
    if (!best || score > best.score) best = { mapId: map.id, advantage, score };
  }
  // With no measurable opponent advantage, it's better to give no advice.
  return best && best.advantage > 2
    ? { mapId: best.mapId, advantage: best.advantage, fromModel: false }
    : null;
}

/** Draws a map at random according to the opposing captain's ban probabilities. */
function sampleTheirBan(remaining: string[], banRates: Map<string, number> | null): string {
  if (!banRates || banRates.size === 0) {
    return remaining[Math.floor(Math.random() * remaining.length)];
  }
  const weights = remaining.map((id) => Math.max(0.5, banRates.get(id) ?? 5));
  const total = weights.reduce((a, b) => a + b, 0);
  let draw = Math.random() * total;
  for (let i = 0; i < remaining.length; i++) {
    draw -= weights[i];
    if (draw <= 0) return remaining[i];
  }
  return remaining[remaining.length - 1];
}

/**
 * Probability (%) that each map ends up being the one played.
 * @param weStartTheVeto true if our side bans first
 */
export function predictFinalMap(
  context: VetoContext,
  weStartTheVeto = true,
  iterations = 1500,
): Map<string, number> {
  // With the model, the distribution is computed exactly rather than sampled.
  if (hasTrainedModel) {
    return modelFinalMap(MODEL, { ...toModelState(context), ourTurn: weStartTheVeto });
  }

  const ids = context.pool.map((m) => m.id);
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return counts;
  if (ids.length === 1) return new Map([[ids[0], 100]]);

  // Our side bans rationally: fixed priority order, computed once.
  const priority = new Map(ids.map((id) => [id, banPriority(context, id)]));

  for (let run = 0; run < iterations; run++) {
    const remaining = [...ids];
    let ourTurn = weStartTheVeto;
    while (remaining.length > 1) {
      let banned: string;
      if (ourTurn) {
        banned = remaining.reduce((a, b) => ((priority.get(b) ?? 0) > (priority.get(a) ?? 0) ? b : a));
      } else {
        banned = sampleTheirBan(remaining, context.banRates);
      }
      remaining.splice(remaining.indexOf(banned), 1);
      ourTurn = !ourTurn;
    }
    counts.set(remaining[0], (counts.get(remaining[0]) ?? 0) + 1);
  }

  const result = new Map<string, number>();
  for (const [id, count] of counts) result.set(id, Math.round((count / iterations) * 100));
  return result;
}
