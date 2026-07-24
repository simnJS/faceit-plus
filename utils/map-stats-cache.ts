import { fetchMapStats, type MapStat, type RecentForm } from './faceit-api';

export interface PlayerHistoryStats {
  maps: MapStat[];
  recent: RecentForm;
}

interface CacheEntry {
  s: MapStat[];
  r: RecentForm;
  t: number; // timestamp d'écriture
}

// v4 : ajout du résumé de forme récente à côté du K/D par map
const CACHE_KEY = 'faceitplus:mapStatsCache:v4';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 h — les stats bougent lentement

/**
 * K/D par map et forme récente de chaque joueur (par uid), via storage.local en
 * cache (TTL 6 h) puis l'historique FACEIT pour les manquants/expirés.
 */
export async function resolveMapStats(uids: string[]): Promise<Map<string, PlayerHistoryStats>> {
  const stored = ((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] ??
    {}) as Record<string, CacheEntry>;
  const now = Date.now();
  const result = new Map<string, PlayerHistoryStats>();
  const missing: string[] = [];

  for (const uid of uids) {
    const hit = stored[uid];
    if (hit && now - hit.t < TTL_MS) {
      result.set(uid, { maps: hit.s, recent: hit.r });
    } else {
      missing.push(uid);
    }
  }

  const fetched = await Promise.allSettled(
    missing.map(async (uid) => [uid, await fetchMapStats(uid)] as const),
  );

  let dirty = false;
  for (const outcome of fetched) {
    if (outcome.status !== 'fulfilled') continue;
    const [uid, stats] = outcome.value;
    result.set(uid, stats);
    stored[uid] = { s: stats.maps, r: stats.recent, t: now };
    dirty = true;
  }
  if (dirty) {
    await browser.storage.local.set({ [CACHE_KEY]: stored });
  }
  return result;
}
