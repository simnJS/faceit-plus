// Model predicting the next ban.
//
// Formulation: conditional logit (McFadden). Rather than classifying among a
// fixed set of maps, we assign a score to each map STILL AVAILABLE and
// normalize over those candidates only. Two decisive advantages here:
//   - pools vary (3 maps in some queues, 7 in others);
//   - the model learns "why" a map is banned, not "which one" on average.
//
// No dependencies: hand-written stochastic gradient descent.

/** Maps encountered in the dataset, order fixed at training time. */
export function collectMaps(rows) {
  const set = new Set();
  for (const row of rows) for (const map of row.remaining ?? []) set.add(map);
  return [...set].sort();
}

/**
 * Auxiliary statistics computed FROM TRAINING DATA ONLY: global ban frequency
 * and each captain's own habits. Computing them over the full dataset would
 * leak information into validation.
 */
export function buildStats(rows, maps) {
  const globalBan = Object.fromEntries(maps.map((m) => [m, 1])); // additive smoothing
  const globalOpp = Object.fromEntries(maps.map((m) => [m, maps.length]));
  const captain = new Map();

  for (const row of rows) {
    for (const map of row.remaining) globalOpp[map] = (globalOpp[map] ?? 0) + 1;
    globalBan[row.banned] = (globalBan[row.banned] ?? 0) + 1;

    const id = row.banner_leader;
    if (!id) continue;
    if (!captain.has(id)) captain.set(id, { ban: {}, opp: {} });
    const c = captain.get(id);
    for (const map of row.remaining) c.opp[map] = (c.opp[map] ?? 0) + 1;
    c.ban[row.banned] = (c.ban[row.banned] ?? 0) + 1;
  }

  const globalRate = {};
  for (const map of maps) globalRate[map] = globalBan[map] / Math.max(1, globalOpp[map]);

  return { globalRate, captain, maps };
}

/** A captain's ban rate on a map, shrunk toward the mean when data is sparse. */
function captainRate(stats, leader, map) {
  const prior = stats.globalRate[map] ?? 0.15;
  const entry = leader ? stats.captain.get(leader) : null;
  if (!entry) return prior;
  const opportunities = entry.opp[map] ?? 0;
  const bans = entry.ban[map] ?? 0;
  const K = 8; // prior weight: ~8 opportunities before trusting the captain's own rate
  return (bans + K * prior) / (opportunities + K);
}

const winrate = (record, map) => {
  const [games, wins] = record?.[map] ?? [0, 0];
  return games > 0 ? wins / games : null;
};

export const FEATURE_NAMES = (maps) => [
  ...maps.map((m) => `map:${m}`),
  'winrate_banner',
  'winrate_opponent',
  'winrate_diff',
  'experience_banner',
  'has_winrate',
  'captain_rate',
  'global_rate',
  'step',
];

/** Feature vector for the (decision, candidate map) pair. */
export function features(row, map, stats) {
  const maps = stats.maps;
  const x = new Float64Array(maps.length + 8);
  const idx = maps.indexOf(map);
  if (idx >= 0) x[idx] = 1;

  const base = maps.length;
  const wrBanner = winrate(row.banner_record, map);
  const wrOpp = winrate(row.opponent_record, map);
  const games = row.banner_record?.[map]?.[0] ?? 0;

  x[base + 0] = wrBanner == null ? 0 : wrBanner - 0.5;
  x[base + 1] = wrOpp == null ? 0 : wrOpp - 0.5;
  // Core signal: teams ban where the opponent is strong and they themselves are weak.
  x[base + 2] = wrBanner == null || wrOpp == null ? 0 : wrOpp - wrBanner;
  x[base + 3] = Math.min(1, Math.log1p(games) / 4);
  x[base + 4] = wrBanner == null ? 0 : 1;
  x[base + 5] = captainRate(stats, row.banner_leader, map) - 0.15;
  x[base + 6] = (stats.globalRate[map] ?? 0.15) - 0.15;
  x[base + 7] = (row.step ?? 0) / 6;
  return x;
}

const dot = (w, x) => {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
};

/** Probability distribution over the candidate maps. */
export function predict(model, row, remaining = row.remaining) {
  const scores = remaining.map((map) => dot(model.weights, features(row, map, model.stats)));
  const max = Math.max(...scores);
  const exp = scores.map((s) => Math.exp(s - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return remaining.map((map, i) => ({ map, p: exp[i] / sum }));
}

/**
 * Training via stochastic gradient descent on cross-entropy loss.
 * `onEpoch` allows tracking progress epoch by epoch.
 */
export function train(rows, { epochs = 30, lr = 0.3, l2 = 1e-4, seed = 1, onEpoch } = {}) {
  const maps = collectMaps(rows);
  const stats = buildStats(rows, maps);
  const dim = maps.length + 8;
  const model = { weights: new Float64Array(dim), stats, maps };

  // Deterministic pseudo-random generator: same conditions on every run.
  let state = seed;
  const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const order = rows.map((_, i) => i);
  for (let epoch = 1; epoch <= epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const rate = lr / (1 + 0.05 * (epoch - 1));
    let loss = 0;

    for (const index of order) {
      const row = rows[index];
      const candidates = row.remaining;
      if (candidates.length < 2) continue;

      const xs = candidates.map((map) => features(row, map, stats));
      const scores = xs.map((x) => dot(model.weights, x));
      const max = Math.max(...scores);
      const exp = scores.map((s) => Math.exp(s - max));
      const sum = exp.reduce((a, b) => a + b, 0);
      const probs = exp.map((e) => e / sum);

      const target = candidates.indexOf(row.banned);
      if (target < 0) continue;
      loss -= Math.log(Math.max(1e-12, probs[target]));

      // Gradient: (probability - actual) for each candidate.
      for (let c = 0; c < candidates.length; c++) {
        const g = probs[c] - (c === target ? 1 : 0);
        const x = xs[c];
        for (let k = 0; k < dim; k++) model.weights[k] -= rate * (g * x[k] + l2 * model.weights[k]);
      }
    }

    if (onEpoch) onEpoch(epoch, loss / Math.max(1, rows.length), model);
  }
  return model;
}

/** Compact serialization, meant to be bundled into the extension. */
export function serialize(model) {
  return JSON.stringify({
    version: 1,
    maps: model.maps,
    weights: [...model.weights].map((w) => Number(w.toFixed(6))),
    globalRate: model.stats.globalRate,
    // Per-captain habits are left out of the file: too large, and
    // recomputable client-side from the opposing captain's history.
  });
}

export function deserialize(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  return {
    weights: Float64Array.from(data.weights),
    maps: data.maps,
    stats: { globalRate: data.globalRate, captain: new Map(), maps: data.maps },
  };
}
