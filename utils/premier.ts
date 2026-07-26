// Fetches a FACEIT player's CS2 Premier rank ("CS Rating").
//
// Data sources (no API key — a fallback chain to maximize coverage):
// FACEIT does NOT store the CS2 Premier rating (Valve's official ranking, separate from
// FACEIT ELO) and Valve exposes no public API. We reconstruct it in two steps:
//
// 1) The player's SteamID64, via the internal FACEIT API (same-origin cookies, open endpoint):
//      GET https://www.faceit.com/api/users/v1/nicknames/{nickname}
//      -> payload.games.cs2.game_id    = SteamID64  (e.g. "76561198010511021")
//      -> payload.platforms.steam.id64 = SteamID64  (identical fallback)
//
// 2) The Premier rating, via a fallback chain (widest source first):
//
//    a) csstats.gg — PRIMARY source, WIDE coverage.
//       HTML page: GET https://csstats.gg/player/{steam64}
//       The current season's Premier rating (or the most recently played season) is
//       server-rendered in the `.cs2rating` badge of the current slot's `<div class="rank">`.
//       Extracted via regex (no DOMParser available in an MV3 service worker).
//       - Covers players absent from Leetify (e.g. test account simnJS_ -> 24,893).
//       CORS: csstats does NOT send `Access-Control-Allow-Origin`. The fetch must therefore
//       run FROM THE SERVICE WORKER (background), which host_permissions exempt from CORS.
//       The content script relays through a runtime message (see below).
//       -> REQUIRED in wxt.config.ts: add 'https://csstats.gg/*' to host_permissions.
//       Cloudflare: csstats sits behind Cloudflare Bot Management. From the user's real
//       browser (residential IP + real Chrome UA, __cf_bm cookie via `credentials:'include'`)
//       the fetch usually goes through, but it can still be challenged (HTTP 403 /
//       `cf-mitigated: challenge`) -> we then fall back to Leetify. Requests are serialized
//       on the background side to avoid tripping the rate limit.
//
//    b) Leetify — FALLBACK, NARROW coverage (only its own users).
//       Public API, open CORS (`Access-Control-Allow-Origin: *`), direct fetch possible:
//       GET https://api-public.cs-prod.leetify.com/v3/profile?steam64_id={steam64}
//       -> ranks.premier = CS2 Premier rating (number) | null (no public Premier) | 404.
//
// No source has 100% coverage: Premier only shows up for players whose matches are known
// (Steam sharing / presence on csstats) or linked to Leetify. A player with no data
// resolves to `rating: null` (also cached, to avoid re-hitting the APIs).
//
// Background bridge (required for csstats because of CORS):
// entrypoints/background.ts MUST call registerPremierBackground() once at startup:
//     import { registerPremierBackground } from '@/utils/premier';
//     export default defineBackground(() => { registerPremierBackground(); /* ... */ });
// The content script (resolvePremierRatings -> fetchPremierRating) then sends a runtime
// message that the background executes (fetch csstats + parsing) and replies with the rating.

export interface PremierInfo {
  /** CS2 Premier rating, or null if unavailable (private profile / no data). */
  rating: number | null;
  /** Resolved SteamID64, or null if the player has no Steam account linked on FACEIT. */
  steam64: string | null;
}

interface CacheEntry {
  r: number | null; // premier rating
  s: string | null; // steam64
  t: number;        // write timestamp
}

const CACHE_KEY = 'faceitplus:premierCache';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Runtime message type sent from the content script to the background for a csstats fetch. */
const CSSTATS_MSG = 'faceitplus:csstats-premier';
interface CsstatsMsg {
  type: typeof CSSTATS_MSG;
  steam64: string;
}
interface CsstatsReply {
  rating: number | null;
}

/** SteamID64 (17 digits) for a FACEIT nickname, via the internal FACEIT API, or null. */
export async function fetchSteam64(nickname: string): Promise<string | null> {
  const res = await fetch(
    `https://www.faceit.com/api/users/v1/nicknames/${encodeURIComponent(nickname)}`,
  );
  if (!res.ok) return null;
  const json = await res.json();
  const payload = json?.payload;
  const id = payload?.games?.cs2?.game_id ?? payload?.platforms?.steam?.id64;
  return typeof id === 'string' && /^\d{17}$/.test(id) ? id : null;
}

/**
 * Extracts the current CS2 Premier rating from a csstats.gg player page's HTML.
 *
 * Targeted structure (server-rendered, one per season played, most recent first):
 *   <div class="rank"><div class="cs2rating <tier> sm" ...><span>24<small>,893</small></span></div></div>
 * `<div class="rank">` = current season slot's rating; `<div class="best">` = peak (ignored).
 * We take the first non-empty current slot (uncalibrated seasons show "---", i.e. a span
 * with no digits, which gets skipped). No DOMParser in an MV3 service worker -> regex.
 */
export function parseCsstatsPremier(html: string): number | null {
  const re =
    /<div class="rank"[^>]*>\s*<div class="cs2rating[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const n = Number.parseInt(m[1].replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Fetches and parses the Premier rating from csstats.gg.
 * Only call this from the background: csstats does not send ACAO, so only the service
 * worker (host_permissions 'https://csstats.gg/*') can read the response without CORS
 * blocking it.
 */
async function fetchCsstatsPremierDirect(steam64: string): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://csstats.gg/player/${encodeURIComponent(steam64)}`, {
      credentials: 'include', // lets the __cf_bm cookie through if the user already visited csstats
      headers: { Accept: 'text/html' },
      signal: controller.signal,
    });
    // Cloudflare challenge (403 / interstitial) or 404 -> give up on csstats.
    if (!res.ok || res.headers.get('cf-mitigated') === 'challenge') return null;
    return parseCsstatsPremier(await res.text());
  } catch {
    return null; // network error, timeout, abort...
  } finally {
    clearTimeout(timeout);
  }
}

// Serialize csstats requests (one room = ~10 players) to go easy on Cloudflare:
// chain the fetches instead of firing them all at once.
let csstatsChain: Promise<unknown> = Promise.resolve();
function queueCsstatsFetch(steam64: string): Promise<number | null> {
  const run = csstatsChain.then(() => fetchCsstatsPremierDirect(steam64));
  csstatsChain = run.catch(() => undefined); // never break the chain
  return run;
}

/**
 * Registers the background bridge for csstats. Call this ONCE from
 * entrypoints/background.ts (inside defineBackground). Coexists with other onMessage
 * listeners: only responds to csstats messages.
 */
export function registerPremierBackground(): void {
  browser.runtime.onMessage.addListener((message: Partial<CsstatsMsg>) => {
    if (message?.type === CSSTATS_MSG && typeof message.steam64 === 'string') {
      return queueCsstatsFetch(message.steam64).then(
        (rating): CsstatsReply => ({ rating }),
      );
    }
    // Other messages: don't respond (let other listeners handle them).
    return undefined;
  });
}

/** Asks the background to resolve the Premier rating via csstats (bypasses CORS). */
async function fetchCsstatsPremierViaBackground(steam64: string): Promise<number | null> {
  try {
    const msg: CsstatsMsg = { type: CSSTATS_MSG, steam64 };
    const reply = (await browser.runtime.sendMessage(msg)) as CsstatsReply | undefined;
    const r = reply?.rating;
    return typeof r === 'number' && r > 0 ? r : null;
  } catch {
    return null; // bridge not registered / service worker unavailable -> fallback
  }
}

async function fetchLeetifyPremier(steam64: string): Promise<number | null> {
  try {
    const url = `https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=${encodeURIComponent(
      steam64,
    )}`;
    const res = await fetch(url); // simple GET, ACAO:* -> no preflight, fetched directly from the content script
    if (!res.ok) return null; // 404 = no Leetify profile
    const json = await res.json();
    const premier = json?.ranks?.premier;
    return typeof premier === 'number' && premier > 0 ? premier : null;
  } catch {
    return null;
  }
}

/**
 * CS2 Premier rating for a SteamID64, via the csstats (wide) -> Leetify (fallback) chain.
 * Called from the content script: csstats goes through the background, Leetify is
 * fetched directly.
 */
export async function fetchPremierRating(steam64: string): Promise<number | null> {
  const fromCsstats = await fetchCsstatsPremierViaBackground(steam64);
  if (fromCsstats != null) return fromCsstats;
  return fetchLeetifyPremier(steam64);
}

/** Resolves the SteamID64 then the Premier rating for a nickname. */
async function resolveOne(nickname: string): Promise<PremierInfo> {
  const steam64 = await fetchSteam64(nickname);
  if (!steam64) return { rating: null, steam64: null };
  const rating = await fetchPremierRating(steam64);
  return { rating, steam64 };
}

/**
 * Resolves the Premier rating for each nickname, via storage.local caching (6h TTL)
 * then the FACEIT + csstats/Leetify APIs for the missing ones.
 *
 * Modeled after resolveCountries() (utils/country-cache.ts): call once when entering
 * the room, then read the Map by nickname when injecting badges. Null results (no
 * public Premier) are also cached, to avoid re-hitting the APIs on every frame/navigation.
 *
 * Since csstats fetches are serialized on the background side, a large enough batch
 * takes several seconds to fully resolve: `onResolved` is called as soon as each player
 * is known, so results can be displayed as they come in instead of all at once.
 *
 * @example
 *   const premierByNickname = await resolvePremierRatings(roster.map(p => p.nickname));
 *   const rating = premierByNickname.get('gla1ve')?.rating; // 22950 | null
 */
export async function resolvePremierRatings(
  nicknames: string[],
  onResolved?: (nickname: string, info: PremierInfo) => void,
): Promise<Map<string, PremierInfo>> {
  const stored = ((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] ??
    {}) as Record<string, CacheEntry>;
  const now = Date.now();
  const result = new Map<string, PremierInfo>();
  const missing: string[] = [];

  for (const nickname of nicknames) {
    const hit = stored[nickname];
    if (hit && now - hit.t < TTL_MS) {
      const info = { rating: hit.r, steam64: hit.s };
      result.set(nickname, info);
      onResolved?.(nickname, info);
    } else {
      missing.push(nickname);
    }
  }

  const fetched = await Promise.allSettled(
    missing.map(async (nickname) => {
      const info = await resolveOne(nickname);
      onResolved?.(nickname, info);
      return [nickname, info] as const;
    }),
  );

  let dirty = false;
  for (const outcome of fetched) {
    if (outcome.status !== 'fulfilled') continue;
    const [nickname, info] = outcome.value;
    result.set(nickname, info);
    stored[nickname] = { r: info.rating, s: info.steam64, t: now };
    dirty = true;
  }
  if (dirty) {
    await browser.storage.local.set({ [CACHE_KEY]: stored });
  }
  return result;
}
