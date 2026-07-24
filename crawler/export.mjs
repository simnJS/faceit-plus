// Transforme la base en jeu d'entraînement, au format « une ligne par décision ».
//
//   npm run crawl:export
//
// Chaque ligne décrit UN ban : l'état du veto à cet instant et tout le contexte
// disponible, plus la map effectivement bannie — la cible à prédire.
//
// Les variables sont données du point de vue du camp qui bannit (`banner_*` /
// `opponent_*`) plutôt que faction1/faction2, dont l'ordre est arbitraire : c'est
// ce que le modèle doit apprendre à exploiter.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: 'crawler/faceit.db' },
    out: { type: 'string', default: 'crawler/dataset.jsonl' },
    'min-pool': { type: 'string', default: '5' },
    'official-only': { type: 'boolean', default: false },
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

const average = (rows, field) => {
  const nums = rows.map((r) => r[field]).filter((v) => typeof v === 'number');
  return nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3)) : null;
};

/** Composition du lobby : diversité des nationalités et plus gros bloc commun. */
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

/** Un nom d'équipe auto-généré (« team_pseudo ») signale une file d'attente. */
const isNamedTeam = (name) => (name ? (/^team_/i.test(name) ? 0 : 1) : null);

const lines = [];
let skipped = 0;

for (const match of matches) {
  if (values['official-only'] && match.organizer !== 'faceit') {
    skipped += 1;
    continue;
  }

  const events = eventsFor.all(match.id);
  const drops = events.filter((e) => e.action === 'drop' && !e.is_random);
  const pool = match.offered_pool
    ? match.offered_pool.split(',')
    : [...new Set(events.map((e) => e.map))].sort();
  if (pool.length < minPool || drops.length === 0) {
    skipped += 1;
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
    // Un veto expédié trahit des choix par défaut ou un joueur absent.
    veto_seconds:
      match.started_at && match.configured_at ? match.started_at - match.configured_at : null,
    pool_size: pool.length,
    pool: pool,
  };

  // On rejoue la séquence : chaque ligne décrit l'état AVANT la décision.
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
        banned: drop.map, // ← cible
        final_map: match.map_picked,
        ...context,
        ...(banner && side[banner] ? prefix(side[banner], 'banner') : {}),
        ...(opponent && side[opponent] ? prefix(side[opponent], 'opponent') : {}),
      }),
    );
    remaining = remaining.filter((m) => m !== drop.map);
  });
}

writeFileSync(values.out, lines.join('\n') + (lines.length ? '\n' : ''));
console.log(
  `${lines.length} décisions écrites dans ${values.out} ` +
    `(${matches.length - skipped} matchs retenus, ${skipped} ignorés).`,
);
db.close();
