// Récupération du rank CS2 Premier (« CS Rating ») d'un joueur FACEIT.
//
// ─────────────────────────────────────────────────────────────────────────────
// SOURCES DE DONNÉES (aucune clé API — chaîne de fallback pour maximiser la couverture)
// ─────────────────────────────────────────────────────────────────────────────
// FACEIT ne stocke PAS le rating Premier CS2 (classement officiel de Valve, séparé de
// l'ELO FACEIT) et Valve n'expose aucune API publique. On le reconstitue en deux temps :
//
// 1) SteamID64 du joueur, via l'API interne FACEIT (cookies same-origin, endpoint ouvert) :
//      GET https://www.faceit.com/api/users/v1/nicknames/{nickname}
//      → payload.games.cs2.game_id    = SteamID64  (ex. "76561198010511021")
//      → payload.platforms.steam.id64 = SteamID64  (fallback identique)
//
// 2) Rating Premier, par une CHAÎNE DE FALLBACK (source la plus large d'abord) :
//
//    a) csstats.gg  — SOURCE PRINCIPALE, couverture LARGE.
//       Page HTML : GET https://csstats.gg/player/{steam64}
//       Le rating Premier de la saison courante (ou de la plus récente saison jouée) est
//       rendu côté serveur dans la pastille `.cs2rating` du slot courant `<div class="rank">`.
//       On l'extrait par regex (pas de DOMParser dans un service worker MV3).
//       • Couvre des joueurs absents de Leetify (dont le compte de test simnJS_ →  24 893).
//       ⚠ CORS : csstats NE renvoie PAS `Access-Control-Allow-Origin`. Le fetch est donc
//         fait DEPUIS LE SERVICE WORKER (background) qui, grâce aux host_permissions, n'est
//         pas soumis au CORS. Le content script passe par un message runtime (voir plus bas).
//         → REQUIS dans wxt.config.ts : ajouter 'https://csstats.gg/*' aux host_permissions.
//       ⚠ Cloudflare : csstats est derrière Cloudflare Bot Management. Depuis le vrai
//         navigateur de l'utilisateur (IP résidentielle + UA Chrome réel, cookie __cf_bm via
//         `credentials:'include'`) le fetch passe en général ; il peut néanmoins être
//         challengé (HTTP 403 / `cf-mitigated: challenge`) → on retombe alors sur Leetify.
//         Les requêtes sont sérialisées côté background pour limiter le rate-limit.
//
//    b) Leetify — SECOURS, couverture ÉTROITE (uniquement ses propres utilisateurs).
//       API publique, CORS ouvert (`Access-Control-Allow-Origin: *`), fetch direct possible :
//       GET https://api-public.cs-prod.leetify.com/v3/profile?steam64_id={steam64}
//       → ranks.premier = rating Premier CS2 (nombre) | null (pas de Premier public) | 404.
//
// Aucune source n'a 100 % de couverture : le Premier n'apparaît que pour les joueurs dont les
// matchs sont connus (partage Steam / présence sur csstats) ou liés à Leetify. Un joueur sans
// donnée renvoie `rating: null` (mis en cache pour ne pas re-solliciter les APIs).
//
// ─────────────────────────────────────────────────────────────────────────────
// PONT BACKGROUND (obligatoire pour csstats à cause du CORS)
// ─────────────────────────────────────────────────────────────────────────────
// entrypoints/background.ts DOIT appeler registerPremierBackground() une fois au démarrage :
//     import { registerPremierBackground } from '@/utils/premier';
//     export default defineBackground(() => { registerPremierBackground(); /* ... */ });
// Le content script (resolvePremierRatings → fetchPremierRating) envoie alors un message
// runtime que le background exécute (fetch csstats + parsing) et dont il renvoie le rating.

export interface PremierInfo {
  /** Rating Premier CS2, ou null si indisponible (profil privé / pas de données). */
  rating: number | null;
  /** SteamID64 résolu, ou null si le joueur n'a pas de compte Steam lié côté FACEIT. */
  steam64: string | null;
}

interface CacheEntry {
  r: number | null; // rating premier
  s: string | null; // steam64
  t: number;        // timestamp d'écriture
}

const CACHE_KEY = 'faceitplus:premierCache';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 h

/** Type du message runtime content → background pour un fetch csstats. */
const CSSTATS_MSG = 'faceitplus:csstats-premier';
interface CsstatsMsg {
  type: typeof CSSTATS_MSG;
  steam64: string;
}
interface CsstatsReply {
  rating: number | null;
}

/** SteamID64 (17 chiffres) d'un pseudo FACEIT, via l'API interne FACEIT, ou null. */
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

// ─────────────────────────────────────────────────────────────────────────────
// csstats.gg (source principale) — extraction + fetch background
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrait le rating Premier CS2 courant depuis le HTML d'une page joueur csstats.gg.
 *
 * Structure ciblée (rendue côté serveur, une par saison jouée, la plus récente en tête) :
 *   <div class="rank"><div class="cs2rating <tier> sm" ...><span>24<small>,893</small></span></div></div>
 * `<div class="rank">` = rating de la saison (slot « courant ») ; `<div class="best">` = pic
 * (ignoré). On prend le premier slot courant NON vide (les saisons non calibrées affichent
 * « --- » → span sans chiffre, sautée). Pas de DOMParser en service worker MV3 → regex.
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
 * Fetch + parsing du rating Premier via csstats.gg.
 * ⚠ À N'APPELER QUE DEPUIS LE BACKGROUND : csstats ne renvoie pas d'ACAO, seul le service
 * worker (host_permissions 'https://csstats.gg/*') peut lire la réponse sans blocage CORS.
 */
async function fetchCsstatsPremierDirect(steam64: string): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://csstats.gg/player/${encodeURIComponent(steam64)}`, {
      credentials: 'include', // laisse passer le cookie __cf_bm si l'utilisateur a déjà visité csstats
      headers: { Accept: 'text/html' },
      signal: controller.signal,
    });
    // Challenge Cloudflare (403 / interstitiel) ou 404 → on abandonne csstats.
    if (!res.ok || res.headers.get('cf-mitigated') === 'challenge') return null;
    return parseCsstatsPremier(await res.text());
  } catch {
    return null; // réseau, timeout, abort…
  } finally {
    clearTimeout(timeout);
  }
}

// Sérialisation des requêtes csstats (une room = ~10 joueurs) pour ménager Cloudflare :
// on enchaîne les fetch au lieu de les lancer en rafale.
let csstatsChain: Promise<unknown> = Promise.resolve();
function queueCsstatsFetch(steam64: string): Promise<number | null> {
  const run = csstatsChain.then(() => fetchCsstatsPremierDirect(steam64));
  csstatsChain = run.catch(() => undefined); // ne jamais casser la file
  return run;
}

/**
 * Enregistre le pont background pour csstats. À appeler UNE FOIS depuis
 * entrypoints/background.ts (dans defineBackground). Coexiste avec d'autres listeners
 * onMessage : ne renvoie une réponse que pour les messages csstats.
 */
export function registerPremierBackground(): void {
  browser.runtime.onMessage.addListener((message: Partial<CsstatsMsg>) => {
    if (message?.type === CSSTATS_MSG && typeof message.steam64 === 'string') {
      return queueCsstatsFetch(message.steam64).then(
        (rating): CsstatsReply => ({ rating }),
      );
    }
    // Autres messages : ne rien renvoyer (laisse les autres listeners répondre).
    return undefined;
  });
}

/** Demande au background de résoudre le Premier via csstats (bypass CORS). */
async function fetchCsstatsPremierViaBackground(steam64: string): Promise<number | null> {
  try {
    const msg: CsstatsMsg = { type: CSSTATS_MSG, steam64 };
    const reply = (await browser.runtime.sendMessage(msg)) as CsstatsReply | undefined;
    const r = reply?.rating;
    return typeof r === 'number' && r > 0 ? r : null;
  } catch {
    return null; // pont non enregistré / service worker indisponible → fallback
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Leetify (secours) — fetch direct (CORS ouvert)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchLeetifyPremier(steam64: string): Promise<number | null> {
  try {
    const url = `https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=${encodeURIComponent(
      steam64,
    )}`;
    const res = await fetch(url); // GET simple, ACAO:* → pas de préflight, direct depuis le content
    if (!res.ok) return null; // 404 = pas de profil Leetify
    const json = await res.json();
    const premier = json?.ranks?.premier;
    return typeof premier === 'number' && premier > 0 ? premier : null;
  } catch {
    return null;
  }
}

/**
 * Rating Premier CS2 pour un SteamID64, via la chaîne csstats (large) → Leetify (secours).
 * Signature publique inchangée (Promise<number | null>). Appelé depuis le content script :
 * csstats passe par le background, Leetify est fetché directement.
 */
export async function fetchPremierRating(steam64: string): Promise<number | null> {
  const fromCsstats = await fetchCsstatsPremierViaBackground(steam64);
  if (fromCsstats != null) return fromCsstats;
  return fetchLeetifyPremier(steam64);
}

/** Résout SteamID64 puis rating Premier pour un pseudo. */
async function resolveOne(nickname: string): Promise<PremierInfo> {
  const steam64 = await fetchSteam64(nickname);
  if (!steam64) return { rating: null, steam64: null };
  const rating = await fetchPremierRating(steam64);
  return { rating, steam64 };
}

/**
 * Résout le rating Premier de chaque pseudo, via storage.local en cache (TTL 6 h)
 * puis les APIs FACEIT + csstats/Leetify pour les manquants.
 *
 * Modelé sur resolveCountries() (utils/country-cache.ts) : à appeler une fois à
 * l'entrée de la room, puis lire la Map par pseudo lors de l'injection des badges.
 * Les résultats null (pas de Premier public) sont aussi mis en cache pour éviter de
 * re-solliciter les APIs à chaque frame / navigation.
 *
 * @example
 *   const premierByNickname = await resolvePremierRatings(roster.map(p => p.nickname));
 *   const rating = premierByNickname.get('gla1ve')?.rating; // 22950 | null
 */
export async function resolvePremierRatings(
  nicknames: string[],
): Promise<Map<string, PremierInfo>> {
  const stored = ((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] ??
    {}) as Record<string, CacheEntry>;
  const now = Date.now();
  const result = new Map<string, PremierInfo>();
  const missing: string[] = [];

  for (const nickname of nicknames) {
    const hit = stored[nickname];
    if (hit && now - hit.t < TTL_MS) {
      result.set(nickname, { rating: hit.r, steam64: hit.s });
    } else {
      missing.push(nickname);
    }
  }

  const fetched = await Promise.allSettled(
    missing.map(async (nickname) => [nickname, await resolveOne(nickname)] as const),
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
