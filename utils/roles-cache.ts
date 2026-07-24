import { fetchLifetimeStats } from './faceit-api';
import { scoreRoles, type RoleResult } from './roles';

interface CacheEntry {
  r: RoleResult;
  t: number;
}

const CACHE_KEY = 'faceitplus:rolesCache';
const TTL_MS = 24 * 60 * 60 * 1000; // les rôles bougent très lentement

/**
 * Rôle estimé de chaque joueur (par uid), via storage.local en cache (TTL 24 h)
 * puis les stats lifetime FACEIT pour les manquants.
 */
export async function resolveRoles(uids: string[]): Promise<Map<string, RoleResult>> {
  const stored = ((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] ?? {}) as Record<
    string,
    CacheEntry
  >;
  const now = Date.now();
  const result = new Map<string, RoleResult>();
  const missing: string[] = [];

  for (const uid of uids) {
    const hit = stored[uid];
    if (hit && now - hit.t < TTL_MS) {
      result.set(uid, hit.r);
    } else {
      missing.push(uid);
    }
  }

  const fetched = await Promise.allSettled(
    missing.map(async (uid) => {
      const stats = await fetchLifetimeStats(uid);
      return [uid, scoreRoles(stats?.lifetime)] as const;
    }),
  );

  let dirty = false;
  for (const outcome of fetched) {
    if (outcome.status !== 'fulfilled') continue;
    const [uid, role] = outcome.value;
    result.set(uid, role);
    stored[uid] = { r: role, t: now };
    dirty = true;
  }
  if (dirty) await browser.storage.local.set({ [CACHE_KEY]: stored });
  return result;
}
