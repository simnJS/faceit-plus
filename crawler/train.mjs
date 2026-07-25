// Entraînement du modèle de prédiction de veto.
//
//   npm run model:train
//
// Découpe temporelle (passé → futur), entraînement, et à chaque époque un point
// d'avancement : perte, précision sur le prochain ban, et de temps en temps la
// précision sur la map finale, qui est l'objectif réel.

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
    // Les poids sont aussi déposés dans l'extension, qui les embarque tels quels.
    'extension-out': { type: 'string', default: 'utils/veto-model-weights.json' },
    epochs: { type: 'string', default: '30' },
    lr: { type: 'string', default: '0.3' },
    l2: { type: 'string', default: '0.0001' },
    'every-final': { type: 'string', default: '5' },
    // Nombre minimal de décisions connues pour le capitaine évalué. En
    // production l'extension dispose toujours de son historique complet.
    'min-captain': { type: 'string', default: '10' },
    // Restreindre aussi l'ENTRAÎNEMENT aux capitaines connus : sinon le poids de
    // leur habitude de veto est dilué par des milliers d'exemples où la variable
    // est vide, alors qu'en production elle est toujours renseignée.
    'train-min-captain': { type: 'string', default: '0' },
  },
});

const rows = readFileSync(values.data, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (rows.length === 0) {
  console.error(`Aucune donnée dans ${values.data}. Lancer npm run crawl:export d'abord.`);
  process.exit(1);
}

const split = temporalSplit(rows, [0.7, 0.15]);
const minCaptain = Number(values['min-captain']);

// L'évaluation se restreint aux capitaines dont on connaît l'historique, ce qui
// reflète la situation réelle de l'extension.
const restrict = (decisions, matches) => {
  const kept = filterByCaptainHistory(decisions, split.train, minCaptain);
  const ids = new Set(kept.map((r) => r.match_id));
  return { rows: kept, matches: matches.filter(([id]) => ids.has(id)) };
};
const val = restrict(split.val, split.valMatches);
const test = restrict(split.test, split.testMatches);

console.log(
  `${rows.length} décisions — entraînement ${split.train.length} (${split.trainMatches.length} matchs), ` +
    `validation ${split.val.length}, test ${split.test.length}`,
);
console.log(
  `Capitaines connus (≥ ${minCaptain} décisions) — validation ${val.rows.length} décisions ` +
    `sur ${val.matches.length} matchs, test ${test.rows.length} sur ${test.matches.length} matchs\n`,
);

if (split.test.length === 0) {
  console.error('Jeu de test vide : il faut plus de matchs pour évaluer honnêtement.');
  process.exit(1);
}

// Repères, calculés sur les statistiques d'entraînement uniquement.
const trainStats = buildStats(split.train, collectMaps(rows));
const ref = baselines(test.rows, test.matches, trainStats);
console.log('Repères sur le jeu de test :');
console.log(
  `  prochain ban  — hasard ${(ref.nextBan.random * 100).toFixed(1)} %` +
    ` | fréquence globale ${(ref.nextBan.frequency * 100).toFixed(1)} %`,
);
console.log(
  `  map finale    — hasard ${(ref.finalMap.random * 100).toFixed(1)} %` +
    ` | map la moins bannie ${(ref.finalMap.frequency * 100).toFixed(1)} %\n`,
);

const everyFinal = Number(values['every-final']);
const history = [];

// La qualité oscille d'une époque à l'autre : la map finale résulte d'un produit
// de probabilités sur six tours, donc de petits écarts de confiance se
// composent. On conserve la meilleure époque plutôt que la dernière.
let best = { score: -1, weights: null, epoch: 0, nextBan: 0, finalMap: 0 };

// Le filtre d'entraînement se calcule sur l'ensemble d'entraînement lui-même :
// un capitaine est « connu » s'il y apparaît suffisamment.
const trainMinCaptain = Number(values['train-min-captain']);
const trainRows = filterByCaptainHistory(split.train, split.train, trainMinCaptain);
if (trainMinCaptain > 0) {
  console.log(
    `Entraînement restreint aux capitaines connus : ${trainRows.length} décisions sur ${split.train.length}\n`,
  );
}

const model = train(trainRows, {
  epochs: Number(values.epochs),
  lr: Number(values.lr),
  l2: Number(values.l2),
  onEpoch: (epoch, loss, current) => {
    // Le suivi et le choix de l'époque se font sur la VALIDATION uniquement.
    const next = nextBanAccuracy(current, val.rows);
    const final = finalMapAccuracy(current, val.matches);
    history.push({ epoch, nextBan: next.accuracy, finalMap: final.accuracy });

    // On arbitre sur la map finale, l'objectif réel, en départageant par le
    // prochain ban quand deux époques se valent.
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
      marker = '  ← meilleure';
    }

    console.log(
      `époque ${String(epoch).padStart(3)} — perte ${loss.toFixed(4)} | ` +
        `prochain ban ${(next.accuracy * 100).toFixed(1)} % | ` +
        `map finale ${(final.accuracy * 100).toFixed(1)} %${marker}`,
    );
  },
});

// On repart des poids de la meilleure époque selon la validation, puis on ne
// mesure qu'UNE FOIS sur le test — jamais consulté jusqu'ici.
if (best.weights) model.weights = best.weights;
const finalNext = nextBanAccuracy(model, test.rows);
const finalMap = finalMapAccuracy(model, test.matches);

const values_ = history.map((h) => h.finalMap);
const mean = values_.reduce((a, b) => a + b, 0) / Math.max(1, values_.length);
const sd = Math.sqrt(
  values_.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values_.length),
);
console.log(
  `\nValidation — map finale : moyenne ${(mean * 100).toFixed(1)} % ` +
    `(écart-type ${(sd * 100).toFixed(1)}), meilleure époque ${best.epoch} à ${(best.finalMap * 100).toFixed(1)} %`,
);
console.log('\n=== Résultat sur le jeu de test (mesure unique, non biaisée) ===');
console.log(
  `prochain ban : ${(finalNext.accuracy * 100).toFixed(1)} % ` +
    `(hasard ${(ref.nextBan.random * 100).toFixed(1)} %, fréquence ${(ref.nextBan.frequency * 100).toFixed(1)} %)`,
);
console.log(
  `map finale   : ${(finalMap.accuracy * 100).toFixed(1)} % ` +
    `(hasard ${(ref.finalMap.random * 100).toFixed(1)} %, moins bannie ${(ref.finalMap.frequency * 100).toFixed(1)} %)`,
);
console.log(`perte logarithmique : ${finalNext.logLoss.toFixed(4)}`);

const payload = serialize(model);
writeFileSync(values.out, payload);
writeFileSync(values['extension-out'], payload);
console.log(`\nModèle écrit dans ${values.out} et ${values['extension-out']}`);
console.log(
  `L'extension embarque ces poids au prochain build : ${(payload.length / 1024).toFixed(1)} Ko.`,
);
