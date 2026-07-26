import { fetchMapStats, type MapStat, type RecentForm } from './faceit-api';

export interface PlayerHistoryStats {
  maps: MapStat[];
  recent: RecentForm;
}

interface CacheEntry {
  s: MapStat[];
  r: RecentForm;
  t: number; // write timestamp
}

// v4: added the recent-form summary alongside per-map K/D
const CACHE_KEY = 'faceitplus:mapStatsCache:v4';
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — stats change slowly

/**
 * Per-map K/D and recent form for each player (by uid), via storage.local caching
 * (6h TTL) then the FACEIT match history for missing/expired entries.
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
