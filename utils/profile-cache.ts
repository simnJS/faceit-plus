import { fetchUserProfile, type UserProfile } from './faceit-api';

interface CacheEntry {
  c: string | null; // country
  d: number | null; // account creation date
  t: number; // write timestamp
}

const CACHE_KEY = 'faceitplus:profileCache';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Public profile for each nickname (country + creation date), via storage.local
 * caching (7-day TTL). A single network call per player, shared by the flag
 * display and smurf detection.
 */
export async function resolveProfiles(nicknames: string[]): Promise<Map<string, UserProfile>> {
  const stored = ((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] ?? {}) as Record<
    string,
    CacheEntry
  >;
  const now = Date.now();
  const result = new Map<string, UserProfile>();
  const missing: string[] = [];

  for (const nickname of nicknames) {
    const hit = stored[nickname];
    if (hit && now - hit.t < TTL_MS) {
      result.set(nickname, { country: hit.c, createdAt: hit.d });
    } else {
      missing.push(nickname);
    }
  }

  const fetched = await Promise.allSettled(
    missing.map(async (nickname) => [nickname, await fetchUserProfile(nickname)] as const),
  );

  let dirty = false;
  for (const outcome of fetched) {
    if (outcome.status !== 'fulfilled') continue;
    const [nickname, profile] = outcome.value;
    result.set(nickname, profile);
    stored[nickname] = { c: profile.country, d: profile.createdAt, t: now };
    dirty = true;
  }
  if (dirty) await browser.storage.local.set({ [CACHE_KEY]: stored });
  return result;
}
