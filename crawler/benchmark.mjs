// Banc d'essai : on rejoue de VRAIS vetos que le modèle n'a jamais vus, sans lui
// dire ce qui a été banni. À chaque tour on affiche sa prédiction, puis la
// réalité. On lui demande aussi, avant le moindre ban, quelle map sera jouée.
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
  console.error('Pas assez de matchs pour constituer un jeu de test.');
  process.exit(1);
}

console.log(
  `Entraînement sur ${split.trainMatches.length} matchs, scénarios tirés des ` +
    `${split.testMatches.length} matchs de test, jamais vus ni pour l'entraînement ni pour le réglage.\n`,
);
const model = train(split.train, { epochs: Number(values.epochs) });

const short = (map) => map.replace(/^de_/, '');
const bar = (p) => '█'.repeat(Math.round(p * 20)).padEnd(20, '·');

// ── Scénarios détaillés ────────────────────────────────────────────────────
const scenarios = split.testMatches.slice(0, Number(values.scenarios));

for (const [matchId, decisions] of scenarios) {
  const pool = decisions[0].remaining;
  const truthFinal = decisions[0].final_map;

  console.log('─'.repeat(72));
  console.log(`Match ${matchId.slice(0, 18)}…  |  ${decisions[0].region}  |  pool de ${pool.length} maps`);
  console.log(`  niveau ${decisions[0].banner_skill_avg ?? '?'} contre ${decisions[0].opponent_skill_avg ?? '?'}`);

  // Prédiction « à l'aveugle », avant le premier ban.
  const upfront = finalMapDistribution(model, decisions);
  const ranked = [...upfront.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n  Avant le veto — map qui sera jouée, selon le modèle :');
  for (const [map, p] of ranked.slice(0, 3)) {
    console.log(`    ${short(map).padEnd(9)} ${bar(p)} ${(p * 100).toFixed(0).padStart(3)} %`);
  }

  console.log('\n  Déroulé tour par tour :');
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
      `    tour ${decision.step + 1} (${decision.banning_faction === 'faction1' ? 'équipe 1' : 'équipe 2'}) ` +
        `prédit : ${top}`,
    );
    console.log(
      `             réel : ${short(actual).padEnd(9)} ${correct ? '✓ trouvé' : `✗ (classé ${rank}ᵉ)`}`,
    );
    remaining = remaining.filter((m) => m !== actual);
  }

  const predictedFinal = ranked[0]?.[0];
  console.log(
    `\n  Map jouée : ${short(truthFinal ?? '?')} — annoncée ${short(predictedFinal ?? '?')} ` +
      `${predictedFinal === truthFinal ? '✓' : '✗'}  |  bans trouvés : ${hits}/${decisions.length}`,
  );
}

// ── Bilan chiffré ──────────────────────────────────────────────────────────
const trainStats = buildStats(split.train, collectMaps(rows));
const ref = baselines(split.test, split.testMatches, trainStats);
const next = nextBanAccuracy(model, split.test);
const final = finalMapAccuracy(model, split.testMatches);

console.log('\n' + '═'.repeat(72));
console.log(`Bilan sur ${split.testMatches.length} matchs jamais vus\n`);
const line = (label, value, refs) =>
  console.log(`  ${label.padEnd(16)} ${(value * 100).toFixed(1).padStart(5)} %   contre ${refs}`);
line(
  'prochain ban',
  next.accuracy,
  `hasard ${(ref.nextBan.random * 100).toFixed(1)} % · fréquence ${(ref.nextBan.frequency * 100).toFixed(1)} %`,
);
line(
  'map finale',
  final.accuracy,
  `hasard ${(ref.finalMap.random * 100).toFixed(1)} % · moins bannie ${(ref.finalMap.frequency * 100).toFixed(1)} %`,
);
console.log(`\n  perte logarithmique : ${next.logLoss.toFixed(4)} (plus bas = mieux calibré)`);
console.log(`  décisions évaluées  : ${next.total}`);
