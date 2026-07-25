// Mesure de la qualité du modèle, partagée par l'entraînement et le banc d'essai.
//
// Deux questions distinctes :
//   1. « quel sera le prochain ban ? » — précision coup par coup ;
//   2. « quelle map sera jouée au final ? » — obtenue en déroulant le veto
//      complet par simulation, c'est ce qui intéresse l'utilisateur.

import { predict } from './model.mjs';

/**
 * Ne garde que les décisions dont le capitaine est réellement connu.
 *
 * En production l'extension récupère en direct l'historique complet du capitaine
 * adverse : elle dispose donc toujours de cette profondeur. Évaluer sur des
 * capitaines vus deux fois mesurerait une situation qui ne se produit jamais, et
 * entraînerait le modèle à ignorer sa variable la plus informative.
 */
export function filterByCaptainHistory(rows, referenceRows, minDecisions) {
  if (!minDecisions || minDecisions < 1) return rows;
  const seen = new Map();
  for (const row of referenceRows) {
    if (row.banner_leader) seen.set(row.banner_leader, (seen.get(row.banner_leader) ?? 0) + 1);
  }
  return rows.filter((row) => (seen.get(row.banner_leader) ?? 0) >= minDecisions);
}

/** Regroupe les décisions par match, dans l'ordre des tours. */
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
 * Découpe temporelle en trois : on entraîne sur le passé, on choisit l'époque
 * sur la validation, et on ne mesure qu'une fois sur le test.
 *
 * Le troisième jeu n'est pas un luxe : la précision sur la map finale oscille de
 * plusieurs points d'une époque à l'autre, si bien que retenir « la meilleure »
 * sur le jeu qui sert aussi à publier le résultat revient à sélectionner un
 * tirage chanceux — et à surestimer la performance réelle.
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

/** Précision sur le prochain ban : part des décisions où la map est trouvée. */
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
 * Déroule le veto complet : à chaque tour on tire une map selon le modèle,
 * jusqu'à n'en laisser qu'une. Répété N fois, ça donne la probabilité que
 * chaque map soit celle finalement jouée.
 */
export function simulateMatch(model, decisions, iterations = 400, rng = Math.random) {
  const pool = decisions[0]?.remaining ?? [];
  if (pool.length === 0) return new Map();
  const counts = new Map(pool.map((m) => [m, 0]));

  for (let run = 0; run < iterations; run++) {
    let remaining = [...pool];
    for (const decision of decisions) {
      if (remaining.length <= 1) break;
      // On garde le contexte réel du tour (capitaine, vécu des équipes) mais on
      // applique le modèle à l'ensemble simulé, qui a pu diverger du réel.
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
 * Distribution EXACTE de la map finale, par programmation dynamique sur les
 * sous-ensembles de maps encore en jeu.
 *
 * Le tirage de Monte-Carlo introduisait une variance telle que deux mesures du
 * même modèle pouvaient différer de plusieurs points — et pénalisait
 * mécaniquement les modèles bien calibrés, dont les tirages sont plus dispersés.
 * Le pool ne dépassant jamais 8 maps, il y a au plus 256 états : on énumère.
 */
export function finalMapDistribution(model, decisions) {
  const pool = decisions[0]?.remaining ?? [];
  const n = pool.length;
  if (n === 0) return new Map();
  if (n === 1) return new Map([[pool[0], 1]]);

  const bitOf = new Map(pool.map((map, i) => [map, 1 << i]));
  const full = (1 << n) - 1;
  const reach = new Float64Array(1 << n); // probabilité d'atteindre chaque état
  reach[full] = 1;

  const popcount = (x) => {
    let c = 0;
    while (x) {
      x &= x - 1;
      c++;
    }
    return c;
  };
  // On traite les états du plus peuplé au plus réduit : chaque ban retire un bit.
  const states = [...Array(1 << n).keys()].filter((m) => m > 0).sort((a, b) => popcount(b) - popcount(a));

  for (const mask of states) {
    const p = reach[mask];
    if (p <= 0) continue;
    const remaining = pool.filter((_, i) => mask & (1 << i));
    if (remaining.length <= 1) continue;
    const step = n - remaining.length;
    if (step >= decisions.length) continue; // le veto s'arrête là
    const distribution = predict(model, decisions[step], remaining);
    for (const option of distribution) {
      reach[mask & ~bitOf.get(option.map)] += p * option.p;
    }
  }

  const result = new Map();
  for (let i = 0; i < n; i++) if (reach[1 << i] > 0) result.set(pool[i], reach[1 << i]);
  return result;
}

/** Précision sur la map finale, sur un ensemble de matchs. */
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

/** Repères de comparaison : sans eux, un score brut ne veut rien dire. */
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

  // Map finale : au hasard parmi le pool, et « la map la moins bannie ».
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
