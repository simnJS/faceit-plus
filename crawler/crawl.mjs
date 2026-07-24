// Crawler FACEIT en boule de neige : on part d'un joueur, on récupère ses matchs,
// puis les joueurs rencontrés dans ces matchs deviennent à leur tour des graines.
// La couverture s'étend d'elle-même à toutes les tranches d'elo.
//
//   FACEIT_API_KEY=xxx node crawler/crawl.mjs --seed simnJS_ --max-matches 5000
//
// Le crawl est reprenable : relancer la commande continue là où on s'est arrêté.

import { parseArgs } from 'node:util';
import { FaceitClient, RateLimiter } from './lib/faceit.mjs';
import { CrawlDb } from './lib/db.mjs';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', multiple: true, default: [] },
    'max-matches': { type: 'string', default: '2000' },
    'max-depth': { type: 'string', default: '4' },
    'per-player': { type: 'string', default: '30' },
    rps: { type: 'string', default: '3' },
    db: { type: 'string', default: 'crawler/faceit.db' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`
Crawler FACEIT — constitue une base de vetos pour entraîner un modèle.

  FACEIT_API_KEY=<clé> node crawler/crawl.mjs --seed <pseudo> [options]

  --seed <pseudo>      point de départ (répétable). Inutile si la base est déjà amorcée.
  --max-matches <n>    nombre de matchs à ajouter avant de s'arrêter (défaut 2000)
  --max-depth <n>      profondeur maximale depuis les graines (défaut 4)
  --per-player <n>     matchs récupérés par joueur (défaut 30, max 100)
  --rps <n>            requêtes par seconde (défaut 3) — reste raisonnable
  --db <fichier>       base SQLite (défaut crawler/faceit.db)

Clé d'API gratuite : https://developers.faceit.com → application → API key (server side).
`);
  process.exit(0);
}

const apiKey = process.env.FACEIT_API_KEY;
if (!apiKey) {
  console.error('FACEIT_API_KEY manquante. Voir --help.');
  process.exit(1);
}

const maxMatches = Number(values['max-matches']);
const maxDepth = Number(values['max-depth']);
const perPlayer = Math.min(100, Number(values['per-player']));

const db = new CrawlDb(values.db);
const client = new FaceitClient({
  apiKey,
  limiter: new RateLimiter(Number(values.rps)),
  onLog: (msg) => console.log(msg),
});

let stopping = false;
process.on('SIGINT', () => {
  console.log('\nArrêt demandé : on termine le joueur en cours…');
  stopping = true;
});

/** Transforme la réponse de l'API officielle en lignes prêtes pour la base. */
function extractMatch(details) {
  const factions = details?.teams ?? {};
  const players = [];
  for (const [faction, team] of Object.entries(factions)) {
    const leaderId = team?.leader;
    for (const p of team?.roster ?? []) {
      players.push({
        id: p.player_id,
        nickname: p.nickname,
        country: p.country ?? null,
        level: p.game_skill_level ?? null,
        elo: p.elo ?? null,
        faction,
        isLeader: p.player_id === leaderId,
      });
    }
  }
  const picked = details?.voting?.map?.pick ?? [];
  return {
    match: {
      id: details.match_id,
      playedAt: (details.started_at ?? details.finished_at ?? 0) * 1000 || null,
      region: details.region ?? null,
      competition: details.competition_type ?? null,
      gameMode: details.game_mode ?? null,
      bestOf: details.best_of ?? null,
      mapPicked: Array.isArray(picked) ? (picked[0] ?? null) : null,
      winner: details.results?.winner ?? null,
    },
    players,
  };
}

function extractVeto(entities) {
  if (!Array.isArray(entities)) return null;
  return entities.map((e) => ({
    map: e.guid ?? e.class_name ?? '',
    action: e.status ?? null,
    selectedBy: e.selected_by ?? null,
    isRandom: Boolean(e.random),
    round: e.round ?? null,
  }));
}

// Amorçage
for (const nickname of values.seed) {
  const player = await client.playerByNickname(nickname);
  if (!player?.player_id) {
    console.error(`Graine introuvable : ${nickname}`);
    continue;
  }
  db.addPlayer({
    id: player.player_id,
    nickname: player.nickname,
    country: player.country ?? null,
    level: player.games?.cs2?.skill_level ?? null,
    elo: player.games?.cs2?.faceit_elo ?? null,
    depth: 0,
  });
  console.log(`Graine : ${player.nickname}`);
}

let added = 0;
const startStats = db.stats();
console.log(
  `Base : ${startStats.matches} matchs (${startStats.withVeto} avec veto), ${startStats.players} joueurs, ${startStats.pending} en attente.\n`,
);

while (added < maxMatches && !stopping) {
  const [next] = db.nextPlayers(1);
  if (!next) {
    console.log('File vide — ajoute une graine avec --seed.');
    break;
  }
  if (next.depth > maxDepth) {
    db.markPlayerCrawled(next.id);
    continue;
  }

  const history = await client.playerHistory(next.id, { limit: perPlayer });
  let newForPlayer = 0;

  for (const item of history) {
    if (added >= maxMatches || stopping) break;
    const matchId = item.match_id ?? item.matchId;
    if (!matchId || db.hasMatch(matchId)) continue;

    const details = await client.matchDetails(matchId);
    if (!details) continue;
    const { match, players } = extractMatch(details);
    // Seuls les matchs avec veto nous intéressent pour le modèle.
    const veto = extractVeto(await client.matchVeto(matchId));

    db.saveMatch(match, players, veto);
    for (const p of players) {
      db.addPlayer({ ...p, depth: next.depth + 1 });
    }
    added += 1;
    newForPlayer += 1;
  }

  db.markPlayerCrawled(next.id);
  const stats = db.stats();
  console.log(
    `${next.nickname ?? next.id} (profondeur ${next.depth}) : +${newForPlayer} matchs — ` +
      `total ${stats.matches}, vetos ${stats.withVeto}, file ${stats.pending}`,
  );
}

const final = db.stats();
console.log(
  `\nTerminé. ${final.matches} matchs dont ${final.withVeto} avec veto ` +
    `(${final.vetoEvents} bans), ${final.players} joueurs connus, ${final.pending} en attente.`,
);
db.close();
