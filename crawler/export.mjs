// Turns the database into a training set, formatted as one line per decision.
//
//   npm run crawl:export
//
// Each line describes ONE ban: the veto state at that moment and all
// available context, plus the map actually banned — the target to predict.
//
// Variables are given from the perspective of the banning side (`banner_*` /
// `opponent_*`) rather than faction1/faction2, whose order is arbitrary: this
// is exactly what the model needs to learn to exploit.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: 'crawler/faceit.db' },
    out: { type: 'string', default: 'crawler/dataset.jsonl' },
    'min-pool': { type: 'string', default: '5' },
    // The crawler also picks up hubs and custom games: aim maps, 1v1 arenas,
    // workshop maps. These don't belong in a competitive veto model and just
    // waste model capacity.
    'official-only': { type: 'boolean', default: true },
    'all-competitions': { type: 'boolean', default: false },
    /** Minimum share of matches a map must appear in to be kept. */
    'min-map-share': { type: 'string', default: '0.02' },
  },
});

const db = new DatabaseSync(values.db);
const minPool = Number(values['min-pool']);

const matches = db
  .prepare(
    `SELECT id, played_at, region, competition, competition_id, competition_name, organizer,
            game_mode, best_of, calculate_elo, configured_at, started_at, map_picked, offered_pool,
            winner, score_faction1, score_faction2
     FROM matches WHERE has_veto = 1`,
  )
  .all();

const eventsFor = db.prepare(
  `SELECT map, action, selected_by, is_random, round
   FROM veto_events WHERE match_id = ? ORDER BY order_index`,
);
const playersFor = db.prepare(
  `SELECT mp.player_id, mp.faction, mp.is_leader, mp.level, p.country
   FROM match_players mp LEFT JOIN players p ON p.id = mp.player_id
   WHERE mp.match_id = ?`,
);
const teamsFor = db.prepare(
  `SELECT faction, name, type, rating, win_probability, skill_avg, skill_min, skill_max
   FROM match_teams WHERE match_id = ?`,
);

// Per-player history, used to compute a team's track record on each map
// BEFORE the date of the match in question: without this temporal filter,
// the model would learn from matches that hadn't happened yet.
const history = new Map();
for (const row of db
  .prepare(
    `SELECT mp.player_id, mp.faction, m.map_picked, m.winner, m.played_at
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE m.map_picked IS NOT NULL AND m.winner IS NOT NULL AND m.played_at IS NOT NULL`,
  )
  .all()) {
  if (!history.has(row.player_id)) history.set(row.player_id, []);
  history.get(row.player_id).push({
    at: row.played_at,
    map: row.map_picked,
    won: row.winner === row.faction ? 1 : 0,
  });
}
for (const list of history.values()) list.sort((a, b) => a.at - b.at);

/** Matches played and won by a team on each map, before `before`. */
function teamMapRecord(playerIds, before, maps) {
  const record = {};
  for (const map of maps) record[map] = [0, 0]; // [played, won]
  for (const id of playerIds) {
    for (const entry of history.get(id) ?? []) {
      if (entry.at >= before) break; // sorted by date, so it's safe to stop here
      const slot = record[entry.map];
      if (slot) {
        slot[0] += 1;
        slot[1] += entry.won;
      }
    }
  }
  return record;
}

const average = (rows, field) => {
  const nums = rows.map((r) => r[field]).filter((v) => typeof v === 'number');
  return nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3)) : null;
};

/** Lobby composition: nationality diversity and the largest shared block. */
function composition(players) {
  const known = players.map((p) => p.country).filter((c) => c && c !== '??');
  if (known.length === 0) return { countries: null, biggestBloc: null, coverage: 0 };
  const counts = new Map();
  for (const c of known) counts.set(c, (counts.get(c) ?? 0) + 1);
  return {
    countries: counts.size,
    biggestBloc: Math.max(...counts.values()),
    coverage: Number((known.length / players.length).toFixed(2)),
  };
}

/** An auto-generated team name (`team_pseudo`) signals a matchmaking queue rather than a premade. */
const isNamedTeam = (name) => (name ? (/^team_/i.test(name) ? 0 : 1) : null);

// First pass: which maps are actually played competitively? We infer this
// from the data rather than hard-coding a list, so it survives changes to
// the official map pool.
const officialOnly = values['official-only'] && !values['all-competitions'];
const eligible = matches.filter(
  (m) => !officialOnly || (m.organizer === 'faceit' && m.game_mode === '5v5' && m.competition === 'matchmaking'),
);
const mapCounts = new Map();
for (const match of eligible) {
  for (const event of eventsFor.all(match.id)) {
    mapCounts.set(event.map, (mapCounts.get(event.map) ?? 0) + 1);
  }
}
const minShare = Number(values['min-map-share']);
const knownMaps = new Set(
  [...mapCounts.entries()]
    .filter(([, count]) => count / Math.max(1, eligible.length) >= minShare)
    .map(([map]) => map),
);
console.log(
  `${knownMaps.size} maps kept out of ${mapCounts.size} seen ` +
    `(threshold: ${(minShare * 100).toFixed(1)}% of matches): ${[...knownMaps].sort().join(', ')}`,
);

const lines = [];
let skipped = 0;
let truncatedPools = 0; // matches where `offered_pool` was smaller than reality
let offMap = 0; // matches dropped because of a map outside the competitive pool

for (const match of eligible) {
  const events = eventsFor.all(match.id);
  const drops = events.filter((e) => e.action === 'drop' && !e.is_random);

  // The starting pool is the set of maps APPEARING IN THE VETO, never
  // `offered_pool`: that field comes from `voting.map.entities`, which shrinks
  // as bans happen. On a finished match it only contains the survivors, which
  // would give a truncated pool — and a falsely easy prediction target.
  const fromEvents = [...new Set(events.map((e) => e.map))].sort();
  const offered = match.offered_pool ? match.offered_pool.split(',') : [];
  const pool = [...new Set([...fromEvents, ...offered])].sort();
  if (offered.length > 0 && offered.length < fromEvents.length) truncatedPools += 1;
  if (pool.length < minPool || drops.length === 0) {
    skipped += 1;
    continue;
  }
  // A single outlier is enough to disqualify the match: a veto mixing
  // competitive maps with workshop maps doesn't describe the same game.
  if (pool.some((map) => !knownMaps.has(map))) {
    offMap += 1;
    continue;
  }

  const players = playersFor.all(match.id);
  const teams = Object.fromEntries(teamsFor.all(match.id).map((t) => [t.faction, t]));
  const side = {};
  for (const faction of ['faction1', 'faction2']) {
    const roster = players.filter((p) => p.faction === faction);
    const team = teams[faction] ?? {};
    const comp = composition(roster);
    side[faction] = {
      leader: roster.find((p) => p.is_leader)?.player_id ?? null,
      level: average(roster, 'level'),
      rating: team.rating ?? null,
      win_probability: team.win_probability ?? null,
      skill_avg: team.skill_avg ?? null,
      skill_min: team.skill_min ?? null,
      skill_max: team.skill_max ?? null,
      skill_spread:
        team.skill_max != null && team.skill_min != null ? team.skill_max - team.skill_min : null,
      team_type: team.type ?? null,
      named_team: isNamedTeam(team.name),
      countries: comp.countries,
      biggest_country_bloc: comp.biggestBloc,
      country_coverage: comp.coverage,
    };
  }

  // Each team's track record on the pool's maps, cut off the day before the match.
  const rosterOf = (faction) => players.filter((p) => p.faction === faction).map((p) => p.player_id);
  const recordOf = {
    faction1: teamMapRecord(rosterOf('faction1'), match.played_at ?? Infinity, pool),
    faction2: teamMapRecord(rosterOf('faction2'), match.played_at ?? Infinity, pool),
  };

  const date = match.played_at ? new Date(match.played_at) : null;
  const context = {
    region: match.region,
    competition: match.competition,
    competition_name: match.competition_name,
    organizer: match.organizer,
    official: match.organizer === 'faceit' ? 1 : 0,
    game_mode: match.game_mode,
    best_of: match.best_of,
    ranked: match.calculate_elo,
    played_at: match.played_at,
    hour_of_day: date ? date.getUTCHours() : null,
    weekday: date ? date.getUTCDay() : null,
    // A rushed veto suggests default picks or an absent player.
    veto_seconds:
      match.started_at && match.configured_at ? match.started_at - match.configured_at : null,
    pool_size: pool.length,
    pool: pool,
  };

  // Replay the sequence: each line describes the state BEFORE the decision.
  let remaining = [...pool];
  drops.forEach((drop, step) => {
    if (!remaining.includes(drop.map)) return;
    const banner = drop.selected_by;
    const opponent = banner === 'faction1' ? 'faction2' : 'faction1';
    const prefix = (obj, tag) =>
      Object.fromEntries(Object.entries(obj).map(([k, v]) => [`${tag}_${k}`, v]));

    lines.push(
      JSON.stringify({
        match_id: match.id,
        step,
        round: drop.round,
        remaining: [...remaining],
        remaining_count: remaining.length,
        banning_faction: banner,
        banned: drop.map, // ← target
        final_map: match.map_picked,
        ...context,
        ...(banner && side[banner] ? prefix(side[banner], 'banner') : {}),
        ...(opponent && side[opponent] ? prefix(side[opponent], 'opponent') : {}),
        // { map: [played, won] } per team, prior to the match
        banner_record: banner ? recordOf[banner] : null,
        opponent_record: opponent ? recordOf[opponent] : null,
      }),
    );
    remaining = remaining.filter((m) => m !== drop.map);
  });
}

writeFileSync(values.out, lines.join('\n') + (lines.length ? '\n' : ''));
console.log(
  `${lines.length} decisions written to ${values.out} ` +
    `(${eligible.length - skipped - offMap} matches kept out of ${matches.length}, ` +
    `${skipped} without a usable veto, ${offMap} outside the competitive pool, ` +
    `${matches.length - eligible.length} outside official matchmaking).`,
);
if (truncatedPools > 0) {
  console.log(
    `${truncatedPools} matches had a truncated offered_pool field (it shrinks with each ban): ` +
      `the pool was reconstructed from the veto sequence.`,
  );
}
db.close();
