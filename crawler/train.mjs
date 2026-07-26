// Training the veto prediction model.
//
//   npm run model:train
//
// Temporal split (past -> future), training, and at each epoch a progress
// report: loss, next-ban accuracy, and occasionally final-map accuracy,
// which is the real objective.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { train, serialize, buildStats, collectMaps } from './lib/model.mjs';
import {
  temporalSplit,
  nextBanAccuracy,
  finalMapAccuracy,
  baselines,
  filterByCaptainHistory,
} from './lib/evaluate.mjs';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'crawler/dataset.jsonl' },
    out: { type: 'string', default: 'crawler/model.json' },
    // The weights are also dropped into the extension, which bundles them as-is.
    'extension-out': { type: 'string', default: 'utils/veto-model-weights.json' },
    epochs: { type: 'string', default: '30' },
    lr: { type: 'string', default: '0.3' },
    l2: { type: 'string', default: '0.0001' },
    'every-final': { type: 'string', default: '5' },
    // Minimum number of known decisions for the evaluated captain. In
    // production the extension always has the captain's full history.
    'min-captain': { type: 'string', default: '10' },
    // Also restrict TRAINING to known captains: otherwise the weight of their
    // veto habit gets diluted by thousands of examples where the variable is
    // empty, even though it is always populated in production.
    'train-min-captain': { type: 'string', default: '0' },
  },
});

const rows = readFileSync(values.data, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (rows.length === 0) {
  console.error(`No data in ${values.data}. Run npm run crawl:export first.`);
  process.exit(1);
}

const split = temporalSplit(rows, [0.7, 0.15]);
const minCaptain = Number(values['min-captain']);

// Evaluation is restricted to captains whose history is known, which
// reflects the extension's real-world situation.
const restrict = (decisions, matches) => {
  const kept = filterByCaptainHistory(decisions, split.train, minCaptain);
  const ids = new Set(kept.map((r) => r.match_id));
  return { rows: kept, matches: matches.filter(([id]) => ids.has(id)) };
};
const val = restrict(split.val, split.valMatches);
const test = restrict(split.test, split.testMatches);

console.log(
  `${rows.length} decisions — training ${split.train.length} (${split.trainMatches.length} matches), ` +
    `validation ${split.val.length}, test ${split.test.length}`,
);
console.log(
  `Known captains (>= ${minCaptain} decisions) — validation ${val.rows.length} decisions ` +
    `across ${val.matches.length} matches, test ${test.rows.length} across ${test.matches.length} matches\n`,
);

if (split.test.length === 0) {
  console.error('Test set is empty: more matches are needed to evaluate honestly.');
  process.exit(1);
}

// Baselines, computed from training statistics only.
const trainStats = buildStats(split.train, collectMaps(rows));
const ref = baselines(test.rows, test.matches, trainStats);
console.log('Baselines on the test set:');
console.log(
  `  next ban      — random ${(ref.nextBan.random * 100).toFixed(1)} %` +
    ` | global frequency ${(ref.nextBan.frequency * 100).toFixed(1)} %`,
);
console.log(
  `  final map     — random ${(ref.finalMap.random * 100).toFixed(1)} %` +
    ` | least banned map ${(ref.finalMap.frequency * 100).toFixed(1)} %\n`,
);

const everyFinal = Number(values['every-final']);
const history = [];

// Quality oscillates from one epoch to another: the final map results from a
// product of probabilities over six rounds, so small confidence gaps compound.
// We keep the best epoch rather than the last one.
let best = { score: -1, weights: null, epoch: 0, nextBan: 0, finalMap: 0 };

// The training filter is computed on the training set itself: a captain is
// "known" if they appear in it often enough.
const trainMinCaptain = Number(values['train-min-captain']);
const trainRows = filterByCaptainHistory(split.train, split.train, trainMinCaptain);
if (trainMinCaptain > 0) {
  console.log(
    `Training restricted to known captains: ${trainRows.length} decisions out of ${split.train.length}\n`,
  );
}

const model = train(trainRows, {
  epochs: Number(values.epochs),
  lr: Number(values.lr),
  l2: Number(values.l2),
  onEpoch: (epoch, loss, current) => {
    // Tracking and epoch selection happen on VALIDATION only.
    const next = nextBanAccuracy(current, val.rows);
    const final = finalMapAccuracy(current, val.matches);
    history.push({ epoch, nextBan: next.accuracy, finalMap: final.accuracy });

    // We arbitrate on the final map, the real objective, breaking ties with
    // the next-ban accuracy when two epochs are close.
    const score = final.accuracy + 0.1 * next.accuracy;
    let marker = '';
    if (score > best.score) {
      best = {
        score,
        weights: Float64Array.from(current.weights),
        epoch,
        nextBan: next.accuracy,
        finalMap: final.accuracy,
      };
      marker = '  ← best';
    }

    console.log(
      `epoch ${String(epoch).padStart(3)} — loss ${loss.toFixed(4)} | ` +
        `next ban ${(next.accuracy * 100).toFixed(1)} % | ` +
        `final map ${(final.accuracy * 100).toFixed(1)} %${marker}`,
    );
  },
});

// We restore the weights of the best epoch according to validation, then
// measure ONLY ONCE on the test set — never consulted until now.
if (best.weights) model.weights = best.weights;
const finalNext = nextBanAccuracy(model, test.rows);
const finalMap = finalMapAccuracy(model, test.matches);

const values_ = history.map((h) => h.finalMap);
const mean = values_.reduce((a, b) => a + b, 0) / Math.max(1, values_.length);
const sd = Math.sqrt(
  values_.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values_.length),
);
console.log(
  `\nValidation — final map: mean ${(mean * 100).toFixed(1)} % ` +
    `(std dev ${(sd * 100).toFixed(1)}), best epoch ${best.epoch} at ${(best.finalMap * 100).toFixed(1)} %`,
);
console.log('\n=== Result on the test set (single, unbiased measurement) ===');
console.log(
  `next ban : ${(finalNext.accuracy * 100).toFixed(1)} % ` +
    `(random ${(ref.nextBan.random * 100).toFixed(1)} %, frequency ${(ref.nextBan.frequency * 100).toFixed(1)} %)`,
);
console.log(
  `final map: ${(finalMap.accuracy * 100).toFixed(1)} % ` +
    `(random ${(ref.finalMap.random * 100).toFixed(1)} %, least banned ${(ref.finalMap.frequency * 100).toFixed(1)} %)`,
);
console.log(`log loss : ${finalNext.logLoss.toFixed(4)}`);

const payload = serialize(model);
writeFileSync(values.out, payload);
writeFileSync(values['extension-out'], payload);
console.log(`\nModel written to ${values.out} and ${values['extension-out']}`);
console.log(
  `The extension will bundle these weights on the next build: ${(payload.length / 1024).toFixed(1)} KB.`,
);
