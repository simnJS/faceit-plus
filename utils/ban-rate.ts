// Probabilité de ban par map, basée sur l'historique de veto du capitaine adverse.
// Réplique la formule de Mappio (reverse engineering v4.4.6) :
//   1. Matchs du capitaine (match-history v5, 100 max / 2 ans), filtrés :
//      il était leader + matchmaking FACEIT + terminé.
//   2. Pour chaque match, historique du veto (democracy) : on compte par map les
//      « drops » actifs du capitaine (selected_by = sa faction, non random,
//      status = "drop") et les opportunités (pondérées par la profondeur du veto,
//      comme Mappio — reproduit tel quel pour des chiffres identiques).
//   3. Lissage bayésien : proba brute = (drops + 2) / (opportunités + 4)
//      (moyenne d'une Beta(drops+2, autres+2)), puis normalisation à 100 % sur le pool.

import {
  fetchCaptainMatchHistory,
  fetchVetoHistory,
  type VetoEntity,
} from './faceit-api';

export interface BanRates {
  /** Nombre de matchs de capitaine analysés (taille de l'échantillon). */
  datasetSize: number;
  /** map codename → probabilité de ban en % (absente si jamais vue au veto). */
  probByMap: Record<string, number>;
  /**
   * Compteurs bruts par map : bans effectifs et occasions. Le modèle applique
   * son propre lissage dessus, identique à celui de l'entraînement — d'où
   * l'exposition des comptes plutôt que d'un taux déjà transformé.
   */
  counts: Record<string, { drops: number; opportunities: number }>;
}

interface CacheEntry {
  d: BanRates;
  t: number;
}

// v2 : ajout des compteurs bruts, nécessaires au modèle
const CACHE_KEY = 'faceitplus:banRateCache:v2';
const TTL_MS = 6 * 60 * 60 * 1000;
const VETO_FETCH_CHUNK = 5; // requêtes democracy en parallèle max

export async function resolveCaptainBanRates(
  captainId: string,
  poolIds: string[],
): Promise<BanRates | null> {
  const stored = ((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] ?? {}) as Record<
    string,
    CacheEntry
  >;
  const now = Date.now();
  const hit = stored[captainId];
  if (hit && now - hit.t < TTL_MS) return hit.d;

  const history = await fetchCaptainMatchHistory(captainId);
  const captainMatches = history.filter(
    (m) =>
      (m.teams?.faction1?.leader === captainId || m.teams?.faction2?.leader === captainId) &&
      m.competition?.type === 'matchmaking' &&
      m.organizer?.id === 'faceit' &&
      m.state === 'finished',
  );
  if (captainMatches.length === 0) return null;

  // Récupération des vetos par paquets (ménage l'API : jusqu'à ~100 requêtes)
  const vetos: Array<{ faction: string; entities: VetoEntity[] }> = [];
  for (let i = 0; i < captainMatches.length; i += VETO_FETCH_CHUNK) {
    const chunk = captainMatches.slice(i, i + VETO_FETCH_CHUNK);
    const results = await Promise.allSettled(
      chunk.map(async (m) => {
        const entities = await fetchVetoHistory(m.matchId);
        if (!entities) return null;
        const faction = m.teams?.faction1?.leader === captainId ? 'faction1' : 'faction2';
        return { faction, entities };
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) vetos.push(r.value);
    }
  }

  // Accumulation drops / opportunités (formule Mappio, pondération incluse)
  const acc = new Map<string, { drop: number; opportunities: number }>();
  for (const { faction, entities } of vetos) {
    let o = 0;
    for (const ent of entities) {
      if (ent.selected_by === faction || ent.round !== 1) {
        o += 1;
        const prev = acc.get(ent.guid) ?? { drop: 0, opportunities: 0 };
        const isActiveDrop =
          ent.selected_by === faction && !ent.random && ent.status === 'drop';
        acc.set(ent.guid, {
          drop: prev.drop + (isActiveDrop ? 1 : 0),
          opportunities: prev.opportunities + o,
        });
      }
    }
  }

  // Beta(drop+2, autres+2).mean puis normalisation à 100 % sur les maps vues
  const seen = poolIds.filter((id) => acc.has(id));
  const raw = new Map<string, number>();
  for (const id of seen) {
    const e = acc.get(id)!;
    raw.set(id, (e.drop + 2) / (e.opportunities + 4));
  }
  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  const probByMap: Record<string, number> = {};
  if (total > 0) {
    for (const [id, value] of raw) {
      probByMap[id] = Math.round((value / total) * 100);
    }
  }

  const counts: Record<string, { drops: number; opportunities: number }> = {};
  for (const [id, entry] of acc) {
    counts[id] = { drops: entry.drop, opportunities: entry.opportunities };
  }

  const data: BanRates = { datasetSize: captainMatches.length, probByMap, counts };
  stored[captainId] = { d: data, t: now };
  await browser.storage.local.set({ [CACHE_KEY]: stored });
  return data;
}
