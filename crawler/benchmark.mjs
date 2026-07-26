// Benchmark: replays REAL vetos the model has never seen, without telling it
// what was banned. At each round we show its prediction, then reality.
// We also ask it, before any ban, which map will be played.
//
//   npm run model:bench
//   npm run model:bench -- --scenarios 5 --epochs 40

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { train, predict } from './lib/model.mjs';
import {
  temporalSplit,
  nextBanAccuracy,
  finalMapAccuracy,
  finalMapDistribution,
  baselines,
} from './lib/evaluate.mjs';
import { buildStats, collectMaps } from './lib/model.mjs';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'crawler/dataset.jsonl' },
    scenarios: { type: 'string', default: '4' },
    epochs: { type: 'string', default: '30' },
  },
});

const rows = readFileSync(values.data, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const split = temporalSplit(rows, [0.7, 0.15]);
if (split.testMatches.length === 0) {
  console.error('Not enough matches to build a test set.');
  process.exit(1);
}

console.log(
  `Training on ${split.trainMatches.length} matches, scenarios drawn from the ` +
    `${split.testMatches.length} test matches, never seen during training or tuning.\n`,
);
const model = train(split.train, { epochs: Number(values.epochs) });

const short = (map) => map.replace(/^de_/, '');
const bar = (p) => '█'.repeat(Math.round(p * 20)).padEnd(20, '·');

const scenarios = split.testMatches.slice(0, Number(values.scenarios));

for (const [matchId, decisions] of scenarios) {
  const pool = decisions[0].remaining;
  const truthFinal = decisions[0].final_map;

  console.log('─'.repeat(72));
  console.log(`Match ${matchId.slice(0, 18)}…  |  ${decisions[0].region}  |  pool of ${pool.length} maps`);
  console.log(`  level ${decisions[0].banner_skill_avg ?? '?'} vs ${decisions[0].opponent_skill_avg ?? '?'}`);

  // Blind prediction, before the first ban.
  const upfront = finalMapDistribution(model, decisions);
  const ranked = [...upfront.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n  Before the veto — map that will be played, according to the model:');
  for (const [map, p] of ranked.slice(0, 3)) {
    console.log(`    ${short(map).padEnd(9)} ${bar(p)} ${(p * 100).toFixed(0).padStart(3)} %`);
  }

  console.log('\n  Round-by-round breakdown:');
  let remaining = [...pool];
  let hits = 0;
  for (const decision of decisions) {
    if (remaining.length < 2) break;
    const distribution = predict(model, decision, remaining).sort((a, b) => b.p - a.p);
    const guess = distribution[0];
    const actual = decision.banned;
    const rank = distribution.findIndex((d) => d.map === actual) + 1;
    const correct = guess.map === actual;
    if (correct) hits += 1;

    const top = distribution
      .slice(0, 3)
      .map((d) => `${short(d.map)} ${(d.p * 100).toFixed(0)}%`)
      .join('  ');
    console.log(
      `    round ${decision.step + 1} (${decision.banning_faction === 'faction1' ? 'team 1' : 'team 2'}) ` +
        `predicted: ${top}`,
    );
    console.log(
      `             actual: ${short(actual).padEnd(9)} ${correct ? '✓ found' : `✗ (rank ${rank})`}`,
    );
    remaining = remaining.filter((m) => m !== actual);
  }

  const predictedFinal = ranked[0]?.[0];
  console.log(
    `\n  Map played: ${short(truthFinal ?? '?')} — predicted ${short(predictedFinal ?? '?')} ` +
      `${predictedFinal === truthFinal ? '✓' : '✗'}  |  bans found: ${hits}/${decisions.length}`,
  );
}

const trainStats = buildStats(split.train, collectMaps(rows));
const ref = baselines(split.test, split.testMatches, trainStats);
const next = nextBanAccuracy(model, split.test);
const final = finalMapAccuracy(model, split.testMatches);

console.log('\n' + '═'.repeat(72));
console.log(`Summary over ${split.testMatches.length} matches never seen before\n`);
const line = (label, value, refs) =>
  console.log(`  ${label.padEnd(16)} ${(value * 100).toFixed(1).padStart(5)} %   vs ${refs}`);
line(
  'next ban',
  next.accuracy,
  `random ${(ref.nextBan.random * 100).toFixed(1)} % · frequency ${(ref.nextBan.frequency * 100).toFixed(1)} %`,
);
line(
  'final map',
  final.accuracy,
  `random ${(ref.finalMap.random * 100).toFixed(1)} % · least banned ${(ref.finalMap.frequency * 100).toFixed(1)} %`,
);
console.log(`\n  log loss           : ${next.logLoss.toFixed(4)} (lower = better calibrated)`);
console.log(`  decisions evaluated: ${next.total}`);
