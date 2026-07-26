// Model quality measurement, shared by training and the benchmark.
//
// Two distinct questions:
//   1. "what will the next ban be?" — move-by-move accuracy;
//   2. "which map will end up being played?" — obtained by simulating the
//      full veto, which is what the user actually cares about.

import { predict } from './model.mjs';

/**
 * Keeps only the decisions where the captain is genuinely known.
 *
 * In production the extension fetches the opposing captain's full history
 * live, so it always has this depth of data. Evaluating on captains seen only
 * twice would measure a situation that never actually occurs, and would train
 * the model to ignore its most informative variable.
 */
export function filterByCaptainHistory(rows, referenceRows, minDecisions) {
  if (!minDecisions || minDecisions < 1) return rows;
  const seen = new Map();
  for (const row of referenceRows) {
    if (row.banner_leader) seen.set(row.banner_leader, (seen.get(row.banner_leader) ?? 0) + 1);
  }
  return rows.filter((row) => (seen.get(row.banner_leader) ?? 0) >= minDecisions);
}

/** Groups decisions by match, in round order. */
export function groupByMatch(rows) {
  const byMatch = new Map();
  for (const row of rows) {
    if (!byMatch.has(row.match_id)) byMatch.set(row.match_id, []);
    byMatch.get(row.match_id).push(row);
  }
  for (const list of byMatch.values()) list.sort((a, b) => a.step - b.step);
  return byMatch;
}

/**
 * Three-way temporal split: train on the past, pick the epoch on validation,
 * and measure only once on the test set.
 *
 * The third set is not a luxury: final-map accuracy swings by several points
 * from one epoch to another, so picking "the best" epoch on the same set used
 * to report the result amounts to cherry-picking a lucky draw — and
 * overstating real performance.
 */
export function temporalSplit(rows, ratios = [0.7, 0.15]) {
  const byMatch = groupByMatch(rows);
  const matches = [...byMatch.entries()].sort(
    (a, b) => (a[1][0].played_at ?? 0) - (b[1][0].played_at ?? 0),
  );
  const trainCut = Math.floor(matches.length * ratios[0]);
  const valCut = trainCut + Math.floor(matches.length * ratios[1]);
  const flatten = (list) => list.flatMap(([, decisions]) => decisions);

  const trainMatches = matches.slice(0, trainCut);
  const valMatches = matches.slice(trainCut, valCut);
  const testMatches = matches.slice(valCut);

  return {
    train: flatten(trainMatches),
    val: flatten(valMatches),
    test: flatten(testMatches),
    trainMatches,
    valMatches,
    testMatches,
  };
}

/** Accuracy on the next ban: share of decisions where the map is correctly identified. */
export function nextBanAccuracy(model, rows) {
  let hits = 0;
  let total = 0;
  let logLoss = 0;
  for (const row of rows) {
    if (!row.remaining || row.remaining.length < 2) continue;
    const distribution = predict(model, row);
    const best = distribution.reduce((a, b) => (b.p > a.p ? b : a));
    const truth = distribution.find((d) => d.map === row.banned);
    if (!truth) continue;
    if (best.map === row.banned) hits += 1;
    logLoss -= Math.log(Math.max(1e-12, truth.p));
    total += 1;
  }
  return { accuracy: total ? hits / total : 0, logLoss: total ? logLoss / total : 0, total };
}

/**
 * Plays out the full veto: at each round a map is drawn according to the
 * model, until only one remains. Repeated N times, this gives the probability
 * that each map ends up being the one played.
 */
export function simulateMatch(model, decisions, iterations = 400, rng = Math.random) {
  const pool = decisions[0]?.remaining ?? [];
  if (pool.length === 0) return new Map();
  const counts = new Map(pool.map((m) => [m, 0]));

  for (let run = 0; run < iterations; run++) {
    let remaining = [...pool];
    for (const decision of decisions) {
      if (remaining.length <= 1) break;
      // We keep the round's real context (captain, teams' track record) but
      // apply the model to the simulated pool, which may have diverged from reality.
      const distribution = predict(model, decision, remaining);
      let draw = rng();
      let chosen = distribution[distribution.length - 1].map;
      for (const option of distribution) {
        draw -= option.p;
        if (draw <= 0) {
          chosen = option.map;
          break;
        }
      }
      remaining = remaining.filter((m) => m !== chosen);
    }
    if (remaining.length === 1) counts.set(remaining[0], (counts.get(remaining[0]) ?? 0) + 1);
  }

  const result = new Map();
  for (const [map, count] of counts) result.set(map, count / iterations);
  return result;
}

/**
 * EXACT distribution of the final map, via dynamic programming over the
 * subsets of maps still in play.
 *
 * Monte Carlo sampling introduced enough variance that two measurements of
 * the same model could differ by several points — and it mechanically
 * penalized well-calibrated models, whose draws are more spread out. Since
 * the pool never exceeds 8 maps, there are at most 256 states, so we
 * enumerate them.
 */
export function finalMapDistribution(model, decisions) {
  const pool = decisions[0]?.remaining ?? [];
  const n = pool.length;
  if (n === 0) return new Map();
  if (n === 1) return new Map([[pool[0], 1]]);

  const bitOf = new Map(pool.map((map, i) => [map, 1 << i]));
  const full = (1 << n) - 1;
  const reach = new Float64Array(1 << n); // probability of reaching each state
  reach[full] = 1;

  const popcount = (x) => {
    let c = 0;
    while (x) {
      x &= x - 1;
      c++;
    }
    return c;
  };
  // We process states from most to least populated: each ban clears one bit.
  const states = [...Array(1 << n).keys()].filter((m) => m > 0).sort((a, b) => popcount(b) - popcount(a));

  for (const mask of states) {
    const p = reach[mask];
    if (p <= 0) continue;
    const remaining = pool.filter((_, i) => mask & (1 << i));
    if (remaining.length <= 1) continue;
    const step = n - remaining.length;
    if (step >= decisions.length) continue; // the veto stops here
    const distribution = predict(model, decisions[step], remaining);
    for (const option of distribution) {
      reach[mask & ~bitOf.get(option.map)] += p * option.p;
    }
  }

  const result = new Map();
  for (let i = 0; i < n; i++) if (reach[1 << i] > 0) result.set(pool[i], reach[1 << i]);
  return result;
}

/** Accuracy on the final map, over a set of matches. */
export function finalMapAccuracy(model, matches) {
  let hits = 0;
  let total = 0;
  for (const [, decisions] of matches) {
    const truth = decisions[0]?.final_map;
    if (!truth) continue;
    const distribution = finalMapDistribution(model, decisions);
    if (distribution.size === 0) continue;
    let best = null;
    for (const [map, p] of distribution) if (!best || p > best[1]) best = [map, p];
    if (best && best[0] === truth) hits += 1;
    total += 1;
  }
  return { accuracy: total ? hits / total : 0, total };
}

/** Comparison baselines: without them, a raw score is meaningless. */
export function baselines(rows, matches, stats) {
  let randomHits = 0;
  let frequencyHits = 0;
  let total = 0;
  for (const row of rows) {
    if (!row.remaining || row.remaining.length < 2) continue;
    randomHits += 1 / row.remaining.length;
    const best = row.remaining.reduce((a, b) =>
      (stats.globalRate[b] ?? 0) > (stats.globalRate[a] ?? 0) ? b : a,
    );
    if (best === row.banned) frequencyHits += 1;
    total += 1;
  }

  // Final map: random pick from the pool, and "the least banned map".
  let randomFinal = 0;
  let frequencyFinal = 0;
  let finalTotal = 0;
  for (const [, decisions] of matches) {
    const pool = decisions[0]?.remaining ?? [];
    const truth = decisions[0]?.final_map;
    if (!pool.length || !truth) continue;
    randomFinal += 1 / pool.length;
    const leastBanned = pool.reduce((a, b) =>
      (stats.globalRate[b] ?? 1) < (stats.globalRate[a] ?? 1) ? b : a,
    );
    if (leastBanned === truth) frequencyFinal += 1;
    finalTotal += 1;
  }

  return {
    nextBan: { random: total ? randomHits / total : 0, frequency: total ? frequencyHits / total : 0 },
    finalMap: {
      random: finalTotal ? randomFinal / finalTotal : 0,
      frequency: finalTotal ? frequencyFinal / finalTotal : 0,
    },
  };
}
