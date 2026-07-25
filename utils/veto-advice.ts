// Conseil de veto et prédiction de la map finale.
//
// Les autres extensions affichent des chiffres bruts ; ici on en tire une décision :
//   • quelle map bannir en priorité (le plus gros avantage adverse, en évitant de
//     « gaspiller » un ban sur une map que le capitaine d'en face bannira lui-même) ;
//   • quelle map a le plus de chances d'être jouée, par simulation de Monte-Carlo
//     du veto restant (notre camp joue rationnellement, le camp adverse suit sa
//     distribution de bans historique).

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

/** Poids entraînés hors ligne. `version: 0` signifie « pas encore entraîné ». */
const MODEL = weights as VetoModel;
export const hasTrainedModel = MODEL.version > 0 && MODEL.maps.length > 0;

export interface VetoContext {
  /** Maps encore en jeu, dans l'ordre du pool. */
  pool: PoolMap[];
  /** Winrates de notre équipe et de l'adverse, par id de map. */
  mine: Map<string, TeamMapStat>;
  theirs: Map<string, TeamMapStat>;
  /** Probabilité (%) que le capitaine adverse bannisse chaque map. */
  banRates: Map<string, number> | null;
  /** Compteurs bruts de veto du capitaine adverse, pour le modèle. */
  captainCounts?: Record<string, { drops: number; opportunities: number }> | null;
  /** true si c'est à notre équipe de bannir maintenant. */
  ourTurn?: boolean;
}

/** Convertit nos statistiques d'équipe au format attendu par le modèle. */
function toRecords(stats: Map<string, TeamMapStat>, pool: PoolMap[]): Map<string, MapRecord> {
  const records = new Map<string, MapRecord>();
  for (const map of pool) {
    const entry = stats.get(map.id);
    records.set(map.id, {
      // Le modèle raisonne en fraction, l'extension stocke des pourcentages.
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
 * Score de priorité de ban : positif = la map avantage l'adversaire.
 * On atténue les maps qu'ils bannissent souvent eux-mêmes (ban redondant).
 */
function banPriority(context: VetoContext, mapId: string): number {
  const advantage = winrate(context.theirs, mapId) - winrate(context.mine, mapId);
  const theirBan = context.banRates?.get(mapId) ?? 0;
  return advantage * (1 - Math.min(theirBan, 60) / 200);
}

export interface BanAdvice {
  mapId: string;
  /** Écart de winrate en notre défaveur sur cette map, en points. */
  advantage: number;
  /** Gain espéré du ban, en points de winrate, quand le modèle est disponible. */
  gain?: number;
  /** true si le conseil vient du modèle entraîné plutôt que de la règle simple. */
  fromModel: boolean;
}

/**
 * Map à bannir en priorité.
 *
 * Avec le modèle entraîné : pour chaque candidate, on déroule tout le reste du
 * veto et on pondère chaque issue par l'avantage qu'elle nous donne. On retient
 * le ban dont l'espérance est la meilleure — ce qui évite notamment de gaspiller
 * un ban sur une map que l'adversaire allait retirer lui-même.
 *
 * Sans modèle, on retombe sur la règle en un coup : bannir là où l'écart de
 * winrate nous est le plus défavorable.
 */
export function recommendBan(context: VetoContext): BanAdvice | null {
  if (context.pool.length <= 1) return null;

  if (hasTrainedModel) {
    const ranked = recommendBans(MODEL, toModelState(context));
    const best = ranked[0];
    // On conseille toujours : « quelle map bannir » a une réponse même quand la
    // marge est mince. Exiger un écart minimum revenait à se taire dans les
    // situations les plus fréquentes, celles où le pool est équilibré.
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
  // Sans avantage adverse mesurable, mieux vaut ne rien conseiller.
  return best && best.advantage > 2
    ? { mapId: best.mapId, advantage: best.advantage, fromModel: false }
    : null;
}

/** Tire une map au sort selon les probabilités de ban du capitaine adverse. */
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
 * Probabilité (%) que chaque map soit celle finalement jouée.
 * @param weStartTheVeto true si c'est à notre camp de bannir en premier
 */
export function predictFinalMap(
  context: VetoContext,
  weStartTheVeto = true,
  iterations = 1500,
): Map<string, number> {
  // Avec le modèle, la distribution est calculée exactement plutôt qu'échantillonnée.
  if (hasTrainedModel) {
    return modelFinalMap(MODEL, { ...toModelState(context), ourTurn: weStartTheVeto });
  }

  const ids = context.pool.map((m) => m.id);
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return counts;
  if (ids.length === 1) return new Map([[ids[0], 100]]);

  // Notre camp bannit rationnellement : ordre de priorité figé, calculé une fois.
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
