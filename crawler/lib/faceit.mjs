// FACEIT client for the crawler.
//
// Two sources, deliberately:
//   - Official API (open.faceit.com/data/v4, requires a key) for discovery:
//     players, history, match details. This is the intended use case for it.
//   - Public veto endpoint (www.faceit.com/api/democracy) for the ban
//     sequence, which the official API does not expose.
//
// One shared rate limiter, one IP address, no rotation or workarounds:
// if you're hitting it too hard, slow down with --rps.

const OFFICIAL = 'https://open.faceit.com/data/v4';
const PUBLIC = 'https://www.faceit.com/api';

/**
 * Rate limiter that's safe under concurrency: each caller reserves its slot
 * synchronously before waiting, which keeps multiple concurrent requests
 * from firing at the same time.
 *
 * The official API advertises its limit in its response headers:
 * "ratelimit-limit: 20, 20;w=1", i.e. 20 requests per rolling second.
 * The crawler stays just under that; 429s are still handled via retry.
 */
export class RateLimiter {
  /** @param {number} rps requests per second */
  constructor(rps) {
    this.minInterval = 1000 / Math.max(0.2, rps);
    this.next = 0;
  }

  async wait() {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.minInterval; // reserve immediately
    const delay = slot - now;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}

export class FaceitClient {
  /**
   * Two separate limiters: the official API and the public veto endpoint
   * don't share the same ceiling (measured: ~30 req/s vs. significantly more).
   * Making them share a single limiter would needlessly throttle both.
   *
   * @param {{apiKey: string, limiter: RateLimiter, vetoLimiter?: RateLimiter,
   *          onLog?: (msg: string) => void}} options
   */
  constructor({ apiKey, limiter, vetoLimiter, onLog = () => {} }) {
    this.apiKey = apiKey;
    this.limiter = limiter;
    this.vetoLimiter = vetoLimiter ?? limiter;
    this.log = onLog;
  }

  /** Rate-limited request with retry on 429/5xx. */
  async #request(url, { auth = true, attempt = 1 } = {}) {
    await (auth ? this.limiter : this.vetoLimiter).wait();
    const headers = { Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${this.apiKey}`;

    let res;
    try {
      res = await fetch(url, { headers });
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return this.#request(url, { auth, attempt: attempt + 1 });
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) return null;
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * attempt;
      this.log(`  ${res.status} — pausing for ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      return this.#request(url, { auth, attempt: attempt + 1 });
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      this.log(`  ${res.status} on ${url.replace(/\?.*/, '')}`);
      return null;
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) return null;
    return res.json();
  }

  /** Player profile looked up by nickname. */
  async playerByNickname(nickname) {
    const url = `${OFFICIAL}/players?nickname=${encodeURIComponent(nickname)}&game=cs2`;
    return this.#request(url);
  }

  /** Full player profile (country, level, elo) looked up by id. */
  async playerById(playerId) {
    return this.#request(`${OFFICIAL}/players/${encodeURIComponent(playerId)}`);
  }

  /**
   * A player's match history (the API has had two paths across versions:
   * try `history`, then fall back to `matches`).
   */
  async playerHistory(playerId, { offset = 0, limit = 100 } = {}) {
    const query = `game=cs2&offset=${offset}&limit=${limit}`;
    const primary = await this.#request(`${OFFICIAL}/players/${playerId}/history?${query}`);
    if (primary?.items) return primary.items;
    const fallback = await this.#request(`${OFFICIAL}/players/${playerId}/matches?${query}`);
    return fallback?.items ?? [];
  }

  async matchDetails(matchId) {
    return this.#request(`${OFFICIAL}/matches/${encodeURIComponent(matchId)}`);
  }

  /**
   * A match's veto sequence. Public endpoint: no key needed, but it still
   * goes through the same rate limiter.
   */
  async matchVeto(matchId) {
    const json = await this.#request(
      `${PUBLIC}/democracy/v1/match/${encodeURIComponent(matchId)}/history`,
      { auth: false },
    );
    const payload = json?.payload ?? json;
    const tickets = payload?.tickets ?? [];
    const mapTicket = tickets.find((t) => t?.entity_type === 'map');
    return mapTicket?.entities ?? null;
  }
}
