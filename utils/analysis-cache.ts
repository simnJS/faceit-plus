import { fetchLifetimeStats, statNumber } from './faceit-api';
import { scoreRoles, type RoleResult } from './roles';

/** Analyse d'un joueur tirée d'un seul appel de stats lifetime. */
export interface PlayerAnalysis {
  role: RoleResult;
  matches: number;
  winrate: number; // %
  kd: number; // K/D moyen par match
  hs: number; // % de headshots
}

interface CacheEntry {
  a: PlayerAnalysis;
  t: number;
}

const CACHE_KEY = 'faceitplus:analysisCache';
const TTL_MS = 24 * 60 * 60 * 1000;

export async function resolveAnalysis(uids: string[]): Promise<Map<string, PlayerAnalysis>> {
  const stored = ((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] ?? {}) as Record<
    string,
    CacheEntry
  >;
  const now = Date.now();
  const result = new Map<string, PlayerAnalysis>();
  const missing: string[] = [];

  for (const uid of uids) {
    const hit = stored[uid];
    if (hit && now - hit.t < TTL_MS) {
      result.set(uid, hit.a);
    } else {
      missing.push(uid);
    }
  }

  const fetched = await Promise.allSettled(
    missing.map(async (uid) => {
      const stats = await fetchLifetimeStats(uid);
      const lifetime = stats?.lifetime;
      const analysis: PlayerAnalysis = {
        role: scoreRoles(lifetime),
        matches: statNumber(lifetime, 'm1') ?? 0,
        winrate: statNumber(lifetime, 'k6') ?? 0,
        kd: statNumber(lifetime, 'k5') ?? 0,
        hs: statNumber(lifetime, 'k8') ?? 0,
      };
      return [uid, analysis] as const;
    }),
  );

  let dirty = false;
  for (const outcome of fetched) {
    if (outcome.status !== 'fulfilled') continue;
    const [uid, analysis] = outcome.value;
    result.set(uid, analysis);
    stored[uid] = { a: analysis, t: now };
    dirty = true;
  }
  if (dirty) await browser.storage.local.set({ [CACHE_KEY]: stored });
  return result;
}
