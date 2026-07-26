// FACEIT's internal API, used by their own frontend, accessible without authentication.
// Fetches run from the content script: same origin as www.faceit.com, so no CORS.

export interface RosterPlayer {
  id: string;
  nickname: string;
  elo?: number;
  gameSkillLevel?: number;
}

interface MapEntity {
  guid?: string;
  game_map_id?: string;
  class_name?: string;
  name?: string;
}

interface Faction {
  roster?: RosterPlayer[];
  /** id of the captain (the one who votes in the veto) */
  leader?: string;
}

interface MatchPayload {
  id: string;
  status?: string;
  state?: string;
  teams?: {
    faction1?: Faction;
    faction2?: Faction;
  };
  voting?: {
    map?: { entities?: MapEntity[]; pick?: string[] };
  };
}

/** true as long as the match isn't finished (veto potentially still in progress). */
export function isMatchLive(match: MatchPayload): boolean {
  const s = (match.status ?? match.state ?? '').toUpperCase();
  return s !== '' && s !== 'FINISHED' && s !== 'CANCELLED' && s !== 'ABORTED';
}

export interface PoolMap {
  id: string; // e.g. "de_dust2"
  name: string; // e.g. "Dust2"
}

// Current active CS2 pool from FACEIT (matchmaking), in veto order. Used as a
// fallback for the "show all" view when the room has already gone past the veto
// (entities reduced). If FACEIT changes the pool, the maps actually voted on
// (entities/pick) get merged on top anyway. Update this if the pool changes.
export const CS2_MAP_POOL: PoolMap[] = [
  { id: 'de_dust2', name: 'Dust2' },
  { id: 'de_mirage', name: 'Mirage' },
  { id: 'de_nuke', name: 'Nuke' },
  { id: 'de_ancient', name: 'Ancient' },
  { id: 'de_inferno', name: 'Inferno' },
  { id: 'de_anubis', name: 'Anubis' },
  { id: 'de_cache', name: 'Cache' },
];

/** Maps still votable in the match (from the veto = remaining after bans), in order. */
export function getMapPool(match: MatchPayload): PoolMap[] {
  const entities = match.voting?.map?.entities ?? [];
  return entities
    .map((e) => {
      const id = e.game_map_id ?? e.guid ?? e.class_name ?? '';
      return { id, name: e.name ?? prettyMapName(id) };
    })
    .filter((m) => m.id);
}

/** Id(s) of the finally selected map(s) (pick), or [] if the veto hasn't concluded. */
export function getPickedMapIds(match: MatchPayload): string[] {
  const pick = match.voting?.map?.pick;
  return Array.isArray(pick) ? pick.filter((id): id is string => typeof id === 'string') : [];
}

export function prettyMapName(id: string): string {
  const n = id.replace(/^de_/, '');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** Extracts the match id from a room URL (`/{lang}/{game}/room/{matchId}[/...]`). */
export function getRoomMatchId(url: string | URL): string | null {
  const match = String(url).match(/\/room\/([^/?#]+)/);
  return match ? match[1] : null;
}

export async function fetchMatch(matchId: string): Promise<MatchPayload> {
  const res = await fetch(`https://www.faceit.com/api/match/v2/match/${encodeURIComponent(matchId)}`);
  if (!res.ok) throw new Error(`match API: HTTP ${res.status}`);
  const json = await res.json();
  return json.payload;
}

export function getMatchRoster(match: MatchPayload): RosterPlayer[] {
  return [
    ...(match.teams?.faction1?.roster ?? []),
    ...(match.teams?.faction2?.roster ?? []),
  ];
}

/** Rosters split by team (for team stats during the veto). */
export function getFactionRosters(match: MatchPayload): {
  faction1: RosterPlayer[];
  faction2: RosterPlayer[];
} {
  return {
    faction1: match.teams?.faction1?.roster ?? [],
    faction2: match.teams?.faction2?.roster ?? [],
  };
}

// FACEIT's real HLTV rating (the faceit_rating field) only exists on the
// `statistics/v1/.../match-rounds` endpoint, which is blocked by Cloudflare for
// extension requests (Repeek/Mappio fetch it through their own backend). So we
// aggregate K/D per map from the open `stats/v1/stats/time` history instead,
// which is accessible with cookies alone.

interface RawHistoryMatch {
  i1?: string; // map (de_dust2, …)
  i6?: string; // kills
  i8?: string; // deaths
  i10?: string; // "1" if win
  c2?: string; // match K/D
}

export interface MapStat {
  map: string; // raw name, e.g. "de_mirage"
  games: number;
  wins: number;
  kd: number; // total kills / total deaths over the period
}

export async function fetchPlayerHistory(uid: string, size = 100): Promise<RawHistoryMatch[]> {
  // game_mode=5v5: same sample as Mappio (excludes wingman & co)
  const url = `https://www.faceit.com/api/stats/v1/stats/time/users/${uid}/games/cs2?page=0&size=${size}&game_mode=5v5`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`history: HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

// Fields are coded (k*/m*). Decoding verified on 2026-07-24 by cross-checking
// with the FACEIT UI: m1=matches, m2=wins, m19=damage, m20=rounds, m21=kills,
// k5=avg K/D per match, k6=winrate %, k8=HS %, k9=K/R, k17=ADR
// (sanity check: m19/m20 == k17 to the decimal).

export type RawStatRecord = Record<string, unknown>;

export interface LifetimeStats {
  /** Raw lifetime object (coded fields). */
  lifetime: RawStatRecord;
  /** Segments per map: codename → raw fields. */
  mapSegments: Record<string, RawStatRecord>;
}

export async function fetchLifetimeStats(uid: string): Promise<LifetimeStats | null> {
  try {
    const res = await fetch(`https://www.faceit.com/api/stats/v1/stats/users/${uid}/games/cs2`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const segments = Array.isArray(json?.segments) ? json.segments : [];
    const mapSegment = segments.find(
      (s: { _id?: { segmentId?: string } }) => s?._id?.segmentId === 'csgo_map',
    );
    return {
      lifetime: (json?.lifetime ?? {}) as RawStatRecord,
      mapSegments: (mapSegment?.segments ?? {}) as Record<string, RawStatRecord>,
    };
  } catch {
    return null;
  }
}

/** Reads a coded field as a number (values are strings on the API side). */
export function statNumber(record: RawStatRecord | undefined, key: string): number | null {
  const raw = record?.[key];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Id of the logged-in player (FACEIT session), or null. */
export async function fetchSelfId(): Promise<string | null> {
  try {
    const res = await fetch('https://www.faceit.com/api/users/v1/sessions/me');
    if (!res.ok) return null;
    const json = await res.json();
    const id = json?.payload?.id ?? json?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/** Captain of the OPPOSING team relative to the given player, or null (spectator, missing data). */
export function getOpposingLeader(match: MatchPayload, playerId: string): string | null {
  const inFaction1 = match.teams?.faction1?.roster?.some((p) => p.id === playerId) ?? false;
  const inFaction2 = match.teams?.faction2?.roster?.some((p) => p.id === playerId) ?? false;
  if (inFaction1) return match.teams?.faction2?.leader ?? null;
  if (inFaction2) return match.teams?.faction1?.leader ?? null;
  return null;
}

export interface CaptainHistoryMatch {
  matchId: string;
  state?: string;
  competition?: { type?: string };
  organizer?: { id?: string };
  teams?: { faction1?: { leader?: string }; faction2?: { leader?: string } };
}

/** Date format expected by match-history v5: YYYY-MM-DDTHH:MM:SS±HHMM (local offset). */
function formatHistoryDate(date: Date, yearsAgo = 0): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetHours = Math.floor(date.getTimezoneOffset() / 60);
  const sign = offsetHours < 0 ? '%2B' : '-'; // "+" is URL-encoded
  const offset = Math.abs(offsetHours).toString().padStart(2, '0').padEnd(4, '0');
  return (
    `${date.getFullYear() - yearsAgo}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offset}`
  );
}

/** ~last 100 matches (2-year window) of a player, via match-history v5. */
export async function fetchCaptainMatchHistory(uid: string): Promise<CaptainHistoryMatch[]> {
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const to = formatHistoryDate(endOfDay);
  const from = formatHistoryDate(endOfDay, 2);
  const url =
    `https://www.faceit.com/api/match-history/v5/players/${uid}/history/` +
    `?page=0&offset=0&to=${to}&from=${from}&size=100&playerId=${uid}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const json = await res.json();
  const list = json?.payload ?? json;
  return Array.isArray(list) ? list : [];
}

export interface VetoEntity {
  guid: string; // map codename (de_dust2…)
  selected_by?: string; // "faction1" | "faction2"
  status?: string; // "drop" | "pick" | …
  random?: boolean;
  round?: number;
}

/** Veto history of a past match (democracy tickets), or null. */
export async function fetchVetoHistory(matchId: string): Promise<VetoEntity[] | null> {
  try {
    const res = await fetch(
      `https://www.faceit.com/api/democracy/v1/match/${encodeURIComponent(matchId)}/history`,
    );
    if (!res.ok) return null;
    const json = await res.json();
    const payload = json?.payload ?? json;
    const tickets: Array<{ entity_type?: string; entities?: VetoEntity[] }> =
      payload?.tickets ?? [];
    const mapTicket = tickets.find((t) => t.entity_type === 'map');
    return mapTicket?.entities ?? null;
  } catch {
    return null;
  }
}

/** K/D (total kills / total deaths) and wins per map, over the given history. */
export function aggregateMapStats(matches: RawHistoryMatch[]): MapStat[] {
  const acc = new Map<string, { kills: number; deaths: number; games: number; wins: number }>();
  for (const m of matches) {
    const map = m.i1;
    if (!map) continue;
    const entry = acc.get(map) ?? { kills: 0, deaths: 0, games: 0, wins: 0 };
    entry.kills += Number(m.i6) || 0;
    entry.deaths += Number(m.i8) || 0;
    entry.games += 1;
    entry.wins += m.i10 === '1' ? 1 : 0;
    acc.set(map, entry);
  }
  return [...acc.entries()]
    .map(([map, e]) => ({
      map,
      games: e.games,
      wins: e.wins,
      kd: e.deaths > 0 ? e.kills / e.deaths : e.kills,
    }))
    .sort((a, b) => b.games - a.games);
}

/** Summary of recent form, across all maps. */
export interface RecentForm {
  games: number;
  kd: number; // total kills / total deaths
  winrate: number; // %
}

export function summarizeRecent(matches: RawHistoryMatch[]): RecentForm {
  let kills = 0;
  let deaths = 0;
  let wins = 0;
  for (const m of matches) {
    kills += Number(m.i6) || 0;
    deaths += Number(m.i8) || 0;
    if (m.i10 === '1') wins += 1;
  }
  const games = matches.length;
  return {
    games,
    kd: deaths > 0 ? kills / deaths : kills,
    winrate: games > 0 ? (wins / games) * 100 : 0,
  };
}

/** Fetches the history once and derives K/D per map + recent form from it. */
export async function fetchMapStats(
  uid: string,
  size = 100,
): Promise<{ maps: MapStat[]; recent: RecentForm }> {
  const history = await fetchPlayerHistory(uid, size);
  return { maps: aggregateMapStats(history), recent: summarizeRecent(history) };
}

export interface UserProfile {
  /** ISO 3166-1 alpha-2 country code, lowercase (e.g. "fr"). */
  country: string | null;
  /** Account creation date (ms epoch), for account age. */
  createdAt: number | null;
}

/** Public profile of a player (single call, shared between flags and smurf detection). */
export async function fetchUserProfile(nickname: string): Promise<UserProfile> {
  try {
    const res = await fetch(
      `https://www.faceit.com/api/users/v1/nicknames/${encodeURIComponent(nickname)}`,
    );
    if (!res.ok) return { country: null, createdAt: null };
    const payload = (await res.json())?.payload;
    const rawCountry = payload?.country;
    const rawCreated = payload?.created_at ?? payload?.activated_at;
    const created = rawCreated ? Date.parse(String(rawCreated)) : NaN;
    return {
      country:
        typeof rawCountry === 'string' && /^[a-z]{2}$/i.test(rawCountry)
          ? rawCountry.toLowerCase()
          : null,
      createdAt: Number.isFinite(created) ? created : null,
    };
  } catch {
    return { country: null, createdAt: null };
  }
}
