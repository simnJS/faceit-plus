// Client FACEIT du crawler.
//
// Deux sources, volontairement :
//   • API officielle (open.faceit.com/data/v4, clé requise) pour la découverte :
//     joueurs, historiques, détails de match. C'est le cadre prévu pour ça.
//   • Endpoint public de veto (www.faceit.com/api/democracy) pour la séquence de
//     bans, que l'API officielle n'expose pas.
//
// Un seul limiteur de débit partagé, une seule adresse IP, pas de rotation ni de
// contournement : si tu tapes trop fort, ralentis avec --rps.

const OFFICIAL = 'https://open.faceit.com/data/v4';
const PUBLIC = 'https://www.faceit.com/api';

/**
 * Limiteur de débit sûr en parallèle : chaque appelant réserve son créneau de
 * façon synchrone avant d'attendre, ce qui évite que plusieurs requêtes
 * concurrentes partent en même temps.
 *
 * Mesuré sur l'API officielle : ~30 req/s passent sans refus, au-delà les 429
 * apparaissent. La valeur par défaut du crawler reste en dessous.
 */
export class RateLimiter {
  /** @param {number} rps requêtes par seconde */
  constructor(rps) {
    this.minInterval = 1000 / Math.max(0.2, rps);
    this.next = 0;
  }

  async wait() {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.minInterval; // réservation immédiate
    const delay = slot - now;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}

export class FaceitClient {
  /**
   * Deux limiteurs distincts : l'API officielle et l'endpoint public de veto
   * n'ont pas le même plafond (mesuré : ~30 req/s contre nettement plus).
   * Les faire partager un seul limiteur bridait inutilement l'ensemble.
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

  /** Requête avec limitation de débit et reprise sur 429/5xx. */
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
      this.log(`  ${res.status} — pause de ${Math.round(wait / 1000)} s`);
      await new Promise((r) => setTimeout(r, wait));
      return this.#request(url, { auth, attempt: attempt + 1 });
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      this.log(`  ${res.status} sur ${url.replace(/\?.*/, '')}`);
      return null;
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) return null;
    return res.json();
  }

  /** Profil d'un joueur à partir de son pseudo. */
  async playerByNickname(nickname) {
    const url = `${OFFICIAL}/players?nickname=${encodeURIComponent(nickname)}&game=cs2`;
    return this.#request(url);
  }

  /** Profil complet d'un joueur (pays, niveau, elo) à partir de son identifiant. */
  async playerById(playerId) {
    return this.#request(`${OFFICIAL}/players/${encodeURIComponent(playerId)}`);
  }

  /**
   * Historique de matchs d'un joueur (l'API a connu deux chemins selon les
   * versions : on tente `history` puis `matches`).
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
   * Séquence de veto d'un match. Endpoint public : pas de clé, mais on le passe
   * par le même limiteur de débit.
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
