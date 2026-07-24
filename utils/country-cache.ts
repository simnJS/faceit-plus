import { fetchUserCountry } from './faceit-api';

interface CacheEntry {
  c: string; // code pays
  t: number; // timestamp d'écriture
}

const CACHE_KEY = 'faceitplus:countryCache';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Résout le pays de chaque pseudo, via storage.local en cache (TTL 7 jours)
 * puis l'API utilisateurs pour les manquants.
 */
export async function resolveCountries(nicknames: string[]): Promise<Map<string, string>> {
  const stored = ((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] ??
    {}) as Record<string, CacheEntry>;
  const now = Date.now();
  const result = new Map<string, string>();
  const missing: string[] = [];

  for (const nickname of nicknames) {
    const hit = stored[nickname];
    if (hit && now - hit.t < TTL_MS) {
      result.set(nickname, hit.c);
    } else {
      missing.push(nickname);
    }
  }

  const fetched = await Promise.allSettled(
    missing.map(async (nickname) => [nickname, await fetchUserCountry(nickname)] as const),
  );

  let dirty = false;
  for (const outcome of fetched) {
    if (outcome.status !== 'fulfilled') continue;
    const [nickname, country] = outcome.value;
    if (!country) continue;
    result.set(nickname, country);
    stored[nickname] = { c: country, t: now };
    dirty = true;
  }
  if (dirty) {
    await browser.storage.local.set({ [CACHE_KEY]: stored });
  }
  return result;
}
