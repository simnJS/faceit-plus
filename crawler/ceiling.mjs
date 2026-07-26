// Estimates the reachable CEILING, to know whether the effort is worth it.
//
//   npm run model:ceiling
//
// Principle: we deliberately cheat. Each captain is credited with their real
// habits computed over ALL of their decisions, including the ones we are
// trying to predict. This is impossible in practice, but it gives the upper
// bound of what a model based on captain habits can hope to achieve.
//
// The gap between this bound and the current model shows whether there is
// room left — and the gap between this bound and 100% measures the share of
// unpredictability in a veto.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { groupByMatch } from './lib/evaluate.mjs';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'crawler/dataset.jsonl' },
    'min-decisions': { type: 'string', default: '10' },
  },
});

const rows = readFileSync(values.data, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const minDecisions = Number(values['min-decisions']);

// Real habits of each captain: bans and opportunities, per map.
const captain = new Map();
for (const row of rows) {
  const id = row.banner_leader;
  if (!id) continue;
  if (!captain.has(id)) captain.set(id, { ban: {}, opp: {}, total: 0 });
  const entry = captain.get(id);
  for (const map of row.remaining) entry.opp[map] = (entry.opp[map] ?? 0) + 1;
  entry.ban[row.banned] = (entry.ban[row.banned] ?? 0) + 1;
  entry.total += 1;
}

const rate = (entry, map) => {
  const opportunities = entry.opp[map] ?? 0;
  return opportunities > 0 ? (entry.ban[map] ?? 0) / opportunities : 0;
};

// Global frequency, for the "without knowledge of the captain" baseline.
const globalBan = {};
const globalOpp = {};
for (const row of rows) {
  for (const map of row.remaining) globalOpp[map] = (globalOpp[map] ?? 0) + 1;
  globalBan[row.banned] = (globalBan[row.banned] ?? 0) + 1;
}
const globalRate = (map) => (globalBan[map] ?? 0) / Math.max(1, globalOpp[map] ?? 1);

let oracleHits = 0;
let globalHits = 0;
let entropySum = 0;
let total = 0;

const eligible = rows.filter(
  (row) => (captain.get(row.banner_leader)?.total ?? 0) >= minDecisions && row.remaining.length > 1,
);

for (const row of eligible) {
  const entry = captain.get(row.banner_leader);

  // Best possible prediction knowing the captain perfectly.
  const best = row.remaining.reduce((a, b) => (rate(entry, b) > rate(entry, a) ? b : a));
  if (best === row.banned) oracleHits += 1;

  const bestGlobal = row.remaining.reduce((a, b) => (globalRate(b) > globalRate(a) ? b : a));
  if (bestGlobal === row.banned) globalHits += 1;

  // Normalized entropy of the decision: measures the share of unpredictability.
  const weights = row.remaining.map((map) => Math.max(1e-9, rate(entry, map)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const probs = weights.map((w) => w / sum);
  const entropy = -probs.reduce((a, p) => a + p * Math.log(p), 0);
  entropySum += entropy / Math.log(row.remaining.length); // 0 = deterministic, 1 = random
  total += 1;
}

console.log(`Decisions kept: ${total} (captains with >= ${minDecisions} decisions)\n`);
console.log(`Ceiling "perfectly known captain": ${((oracleHits / total) * 100).toFixed(1)} %`);
console.log(`Baseline "global frequency"      : ${((globalHits / total) * 100).toFixed(1)} %`);
console.log(
  `Share of unpredictability in the decision: ${((entropySum / total) * 100).toFixed(1)} % ` +
    `(0% = perfectly predictable captain, 100% = random choice)`,
);
console.log(
  `\nCompare this to the current model. The gap with the ceiling shows how much room is left;\n` +
    `the ceiling itself shows what no model will ever exceed.`,
);
