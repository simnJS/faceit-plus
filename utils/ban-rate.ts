// Ban probability per map, based on the opposing captain's veto history.
// Replicates Mappio's formula (reverse-engineered from v4.4.6):
//   1. Captain's matches (match-history v5, 100 max / 2 years), filtered to:
//      they were leader + FACEIT matchmaking + finished.
//   2. For each match, veto history (democracy): count per map the captain's
//      active "drops" (selected_by = their faction, not random,
//      status = "drop") and opportunities (weighted by veto depth,
//      same as Mappio — reproduced as-is for identical numbers).
//   3. Bayesian smoothing: raw probability = (drops + 2) / (opportunities + 4)
//      (mean of a Beta(drops+2, others+2)), then normalized to 100% over the pool.

import {
  fetchCaptainMatchHistory,
  fetchVetoHistory,
  type VetoEntity,
} from './faceit-api';

export interface BanRates {
  /** Number of captain matches analyzed (sample size). */
  datasetSize: number;
  /** map codename → ban probability in % (absent if never seen in a veto). */
  probByMap: Record<string, number>;
  /**
   * Raw per-map counts: actual bans and opportunities. The model applies its
   * own smoothing on top of these, identical to the one used during training —
   * hence exposing raw counts rather than an already-transformed rate.
   */
  counts: Record<string, { drops: number; opportunities: number }>;
}

interface CacheEntry {
  d: BanRates;
  t: number;
}

// v2: added raw counts, needed by the model
const CACHE_KEY = 'faceitplus:banRateCache:v2';
const TTL_MS = 6 * 60 * 60 * 1000;
const VETO_FETCH_CHUNK = 5; // max parallel democracy requests

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

  // Fetch vetos in chunks (goes easy on the API: up to ~100 requests)
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

  // Accumulate drops / opportunities (Mappio formula, weighting included)
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

  // Beta(drop+2, others+2).mean then normalized to 100% over maps seen
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
