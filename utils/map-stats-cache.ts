import { fetchMapStats, type MapStat } from './faceit-api';

interface CacheEntry {
  s: MapStat[];
  t: number; // timestamp d'écriture
}

// v3 : ajout de `wins` + filtre game_mode=5v5 sur l'historique
const CACHE_KEY = 'faceitplus:mapStatsCache:v3';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 h — les stats bougent lentement

/**
 * K/D par map de chaque joueur (par uid), via storage.local en cache (TTL 6 h)
 * puis l'historique FACEIT pour les manquants/expirés.
 */
export async function resolveMapStats(uids: string[]): Promise<Map<string, MapStat[]>> {
  const stored = ((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] ??
    {}) as Record<string, CacheEntry>;
  const now = Date.now();
  const result = new Map<string, MapStat[]>();
  const missing: string[] = [];

  for (const uid of uids) {
    const hit = stored[uid];
    if (hit && now - hit.t < TTL_MS) {
      result.set(uid, hit.s);
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
    stored[uid] = { s: stats, t: now };
    dirty = true;
  }
  if (dirty) {
    await browser.storage.local.set({ [CACHE_KEY]: stored });
  }
  return result;
}
