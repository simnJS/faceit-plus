// Estimation du PLAFOND atteignable, pour savoir si l'effort en vaut la peine.
//
//   npm run model:ceiling
//
// Principe : on triche délibérément. Chaque capitaine se voit attribuer ses
// habitudes réelles calculées sur TOUTES ses décisions, y compris celles qu'on
// cherche à prédire. C'est impossible en pratique, mais ça donne la borne haute
// de ce qu'un modèle fondé sur l'habitude du capitaine peut espérer.
//
// L'écart entre cette borne et le modèle actuel dit s'il reste de la marge — et
// l'écart entre cette borne et 100 % mesure la part d'imprévisible d'un veto.

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

// Habitudes réelles de chaque capitaine : bans et occasions, par map.
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

// Fréquence globale, pour le repère « sans connaissance du capitaine ».
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

  // Meilleure prédiction possible connaissant parfaitement le capitaine.
  const best = row.remaining.reduce((a, b) => (rate(entry, b) > rate(entry, a) ? b : a));
  if (best === row.banned) oracleHits += 1;

  const bestGlobal = row.remaining.reduce((a, b) => (globalRate(b) > globalRate(a) ? b : a));
  if (bestGlobal === row.banned) globalHits += 1;

  // Entropie de la décision, normalisée : mesure la part d'imprévisible.
  const weights = row.remaining.map((map) => Math.max(1e-9, rate(entry, map)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const probs = weights.map((w) => w / sum);
  const entropy = -probs.reduce((a, p) => a + p * Math.log(p), 0);
  entropySum += entropy / Math.log(row.remaining.length); // 0 = déterministe, 1 = au hasard
  total += 1;
}

console.log(`Décisions retenues : ${total} (capitaines avec ≥ ${minDecisions} décisions)\n`);
console.log(`Plafond « capitaine parfaitement connu » : ${((oracleHits / total) * 100).toFixed(1)} %`);
console.log(`Repère « fréquence globale »             : ${((globalHits / total) * 100).toFixed(1)} %`);
console.log(
  `Part d'imprévisible dans la décision      : ${((entropySum / total) * 100).toFixed(1)} % ` +
    `(0 % = capitaine parfaitement prévisible, 100 % = choix au hasard)`,
);
console.log(
  `\nÀ comparer au modèle actuel. L'écart avec le plafond dit ce qu'il reste à gagner ;\n` +
    `le plafond lui-même dit ce qu'aucun modèle ne pourra dépasser.`,
);
