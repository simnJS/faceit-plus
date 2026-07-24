// Transforme la base en jeu d'entraînement, au format « une ligne par décision ».
//
//   node crawler/export.mjs --out dataset.jsonl
//
// Chaque ligne décrit UN ban : l'état du veto à cet instant (maps encore en jeu,
// numéro du tour, camp qui bannit, contexte des deux équipes) et la map
// effectivement bannie — c'est la cible à prédire. C'est le bon format pour un
// modèle de politique : on l'entraîne à prédire le prochain ban, puis on déroule
// le modèle pour obtenir la map finale.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: 'crawler/faceit.db' },
    out: { type: 'string', default: 'crawler/dataset.jsonl' },
    'min-pool': { type: 'string', default: '5' },
  },
});

const db = new DatabaseSync(values.db);
const minPool = Number(values['min-pool']);

const matches = db
  .prepare(
    `SELECT id, played_at, region, competition, game_mode, map_picked
     FROM matches WHERE has_veto = 1`,
  )
  .all();

const eventsFor = db.prepare(
  `SELECT map, action, selected_by, is_random, round
   FROM veto_events WHERE match_id = ? ORDER BY order_index`,
);
const playersFor = db.prepare(
  `SELECT player_id, faction, is_leader, level, elo
   FROM match_players WHERE match_id = ?`,
);

const lines = [];
let skipped = 0;

for (const match of matches) {
  const events = eventsFor.all(match.id);
  const drops = events.filter((e) => e.action === 'drop' && !e.is_random);
  // Le pool de départ, c'est l'ensemble des maps qui apparaissent dans le veto.
  const pool = [...new Set(events.map((e) => e.map))].sort();
  if (pool.length < minPool || drops.length === 0) {
    skipped += 1;
    continue;
  }

  const players = playersFor.all(match.id);
  const team = (faction) => players.filter((p) => p.faction === faction);
  const average = (rows, field) => {
    const values = rows.map((r) => r[field]).filter((v) => typeof v === 'number');
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const context = {
    region: match.region,
    competition: match.competition,
    game_mode: match.game_mode,
    played_at: match.played_at,
    faction1_elo: average(team('faction1'), 'elo'),
    faction2_elo: average(team('faction2'), 'elo'),
    faction1_level: average(team('faction1'), 'level'),
    faction2_level: average(team('faction2'), 'level'),
    faction1_leader: team('faction1').find((p) => p.is_leader)?.player_id ?? null,
    faction2_leader: team('faction2').find((p) => p.is_leader)?.player_id ?? null,
  };

  // On rejoue la séquence : à chaque ban, on décrit l'état AVANT la décision.
  let remaining = [...pool];
  drops.forEach((drop, step) => {
    if (!remaining.includes(drop.map)) return;
    lines.push(
      JSON.stringify({
        match_id: match.id,
        step,
        remaining: [...remaining],
        banning_faction: drop.selected_by,
        banning_leader:
          drop.selected_by === 'faction1' ? context.faction1_leader : context.faction2_leader,
        banned: drop.map, // ← cible
        final_map: match.map_picked,
        ...context,
      }),
    );
    remaining = remaining.filter((m) => m !== drop.map);
  });
}

writeFileSync(values.out, lines.join('\n') + (lines.length ? '\n' : ''));
console.log(
  `${lines.length} décisions écrites dans ${values.out} ` +
    `(${matches.length - skipped} matchs retenus, ${skipped} ignorés faute de veto exploitable).`,
);
db.close();
