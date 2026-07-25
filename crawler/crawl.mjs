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

// Charge .env s'il existe (clé d'API, graine par défaut). Sans dépendance.
try {
  process.loadEnvFile();
} catch {
  // pas de .env : on se rabat sur les variables d'environnement du shell
}

const { values } = parseArgs({
  options: {
    seed: { type: 'string', multiple: true, default: [] },
    'max-matches': { type: 'string', default: '2000' },
    'max-depth': { type: 'string', default: '4' },
    'per-player': { type: 'string', default: '80' },
    strategy: { type: 'string', default: 'depth' },
    rps: { type: 'string', default: '18' },
    'veto-rps': { type: 'string', default: '35' },
    concurrency: { type: 'string', default: '10' },
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
  --per-player <n>     matchs récupérés par joueur (défaut 80, max 100)
  --strategy <mode>    depth (défaut) : densifie autour des joueurs déjà croisés
                       breadth : s'éloigne vite des graines, couverture plus large

  La profondeur compte davantage que le volume : un capitaine vu trois fois
  n'apprend rien au modèle, il en faut plusieurs dizaines.
  --rps <n>            plafond sur l'API officielle (défaut 18)
  --veto-rps <n>       plafond sur l'endpoint de veto (défaut 35)
  --concurrency <n>    matchs traités en parallèle (défaut 10)

  L'API annonce sa limite dans ses en-têtes : « ratelimit-limit: 20, 20;w=1 »,
  soit 20 requêtes par seconde. La valeur par défaut reste juste en dessous.
  --db <fichier>       base SQLite (défaut crawler/faceit.db)

Clé d'API gratuite : https://developers.faceit.com → application → API key (server side).
`);
  process.exit(0);
}

const apiKey = process.env.FACEIT_API_KEY;
if (!apiKey) {
  console.error('FACEIT_API_KEY manquante : renseigne-la dans .env (voir .env.example).');
  process.exit(1);
}

// Graine : --seed prioritaire, sinon FACEIT_SEED du .env.
const seeds = values.seed.length > 0 ? values.seed : [process.env.FACEIT_SEED].filter(Boolean);

const maxMatches = Number(values['max-matches']);
const maxDepth = Number(values['max-depth']);
const perPlayer = Math.min(100, Number(values['per-player']));
const concurrency = Math.max(1, Number(values.concurrency));

const db = new CrawlDb(values.db);
const client = new FaceitClient({
  apiKey,
  limiter: new RateLimiter(Number(values.rps)),
  vetoLimiter: new RateLimiter(Number(values['veto-rps'])),
  onLog: (msg) => console.log(msg),
});

let stopping = false;
process.on('SIGINT', () => {
  console.log('\nArrêt demandé : on termine le joueur en cours…');
  stopping = true;
});

/**
 * Transforme la réponse de l'API officielle en lignes prêtes pour la base.
 * `historyItem` complète les champs que le détail de match n'expose pas toujours.
 */
function extractMatch(details, historyItem = {}) {
  const factions = details?.teams ?? {};
  const players = [];
  const teams = [];

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
    // `stats` porte l'estimation FACEIT : probabilité de victoire, rating
    // d'équipe et étendue des niveaux (indice d'hétérogénéité du lobby).
    const stats = team?.stats ?? {};
    teams.push({
      faction,
      name: team?.name ?? null,
      type: team?.type ?? null,
      rating: stats.rating ?? null,
      winProbability: stats.winProbability ?? null,
      skillAvg: stats.skillLevel?.average ?? null,
      skillMin: stats.skillLevel?.range?.min ?? null,
      skillMax: stats.skillLevel?.range?.max ?? null,
    });
  }

  const picked = details?.voting?.map?.pick ?? [];
  const offered = (details?.voting?.map?.entities ?? [])
    .map((e) => e.class_name ?? e.guid)
    .filter(Boolean);

  return {
    match: {
      id: details.match_id,
      playedAt: (details.started_at ?? details.finished_at ?? 0) * 1000 || null,
      region: details.region ?? historyItem.region ?? null,
      competition: details.competition_type ?? historyItem.competition_type ?? null,
      competitionId: details.competition_id ?? null,
      competitionName: details.competition_name ?? null,
      organizer: details.organizer_id ?? null,
      gameMode: details.game_mode ?? historyItem.game_mode ?? null,
      bestOf: details.best_of ?? null,
      calculateElo: details.calculate_elo ?? null,
      status: details.status ?? null,
      configuredAt: details.configured_at ?? null,
      startedAt: details.started_at ?? null,
      finishedAt: details.finished_at ?? null,
      mapPicked: Array.isArray(picked) ? (picked[0] ?? null) : null,
      offeredPool: offered.length ? offered.join(',') : null,
      winner: details.results?.winner ?? null,
      scoreFaction1: details.results?.score?.faction1 ?? null,
      scoreFaction2: details.results?.score?.faction2 ?? null,
    },
    players,
    teams,
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
for (const nickname of seeds) {
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
  const [next] = db.nextPlayers(1, values.strategy);
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

  // Les matchs inconnus sont traités en parallèle : le limiteur de débit
  // partagé garde l'ensemble sous le plafond de l'API.
  const todo = history
    .map((item) => ({ item, matchId: item.match_id ?? item.matchId }))
    .filter(({ matchId }) => matchId && !db.hasMatch(matchId));

  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < todo.length && added < maxMatches && !stopping) {
        const { item, matchId } = todo[cursor++];
        const [details, vetoEntities] = await Promise.all([
          client.matchDetails(matchId),
          client.matchVeto(matchId),
        ]);
        if (!details) continue;
        const { match, players, teams } = extractMatch(details, item);
        db.saveMatch(match, players, extractVeto(vetoEntities), teams);
        for (const p of players) {
          db.addPlayer({ ...p, depth: next.depth + 1 });
        }
        added += 1;
        newForPlayer += 1;
      }
    }),
  );

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
