// FACEIT snowball crawler: start from a single player, fetch their matches,
// then the players encountered in those matches become seeds in turn.
// Coverage expands on its own across every skill bracket.
//
//   FACEIT_API_KEY=xxx node crawler/crawl.mjs --seed simnJS_ --max-matches 5000
//
// The crawl is resumable: rerunning the command picks up where it left off.

import { parseArgs } from 'node:util';
import { FaceitClient, RateLimiter } from './lib/faceit.mjs';
import { CrawlDb } from './lib/db.mjs';

// Load .env if present (API key, default seed). No dependency needed.
try {
  process.loadEnvFile();
} catch {
  // no .env: fall back to the shell's environment variables
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
FACEIT crawler — builds a veto database to train a model.

  FACEIT_API_KEY=<key> node crawler/crawl.mjs --seed <nickname> [options]

  --seed <nickname>    starting point (repeatable). Not needed if the database is already seeded.
  --max-matches <n>    number of matches to add before stopping (default 2000)
  --max-depth <n>      maximum depth from the seeds (default 4)
  --per-player <n>     matches fetched per player (default 80, max 100)
  --strategy <mode>    depth (default): densifies around players already seen
                       breadth: moves away from seeds faster, wider coverage

  Depth matters more than volume: a captain seen three times teaches the
  model nothing, it takes several dozen.
  --rps <n>            cap on the official API (default 18)
  --veto-rps <n>       cap on the veto endpoint (default 35)
  --concurrency <n>    matches processed in parallel (default 10)

  The API advertises its limit in its headers: "ratelimit-limit: 20, 20;w=1",
  i.e. 20 requests per second. The default stays just under that.
  --db <file>          SQLite database (default crawler/faceit.db)

Free API key: https://developers.faceit.com → application → API key (server side).
`);
  process.exit(0);
}

const apiKey = process.env.FACEIT_API_KEY;
if (!apiKey) {
  console.error('Missing FACEIT_API_KEY: set it in .env (see .env.example).');
  process.exit(1);
}

// Seed: --seed takes priority, otherwise FACEIT_SEED from .env.
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
  console.log('\nStop requested: finishing the current player…');
  stopping = true;
});

/**
 * Turns the official API response into rows ready for the database.
 * `historyItem` fills in fields that the match details don't always expose.
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
    // `stats` carries FACEIT's estimate: win probability, team rating, and
    // the skill-level range (an indicator of lobby heterogeneity).
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

for (const nickname of seeds) {
  const player = await client.playerByNickname(nickname);
  if (!player?.player_id) {
    console.error(`Seed not found: ${nickname}`);
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
  console.log(`Seed: ${player.nickname}`);
}

let added = 0;
const startStats = db.stats();
console.log(
  `Database: ${startStats.matches} matches (${startStats.withVeto} with veto), ${startStats.players} players, ${startStats.pending} pending.\n`,
);

while (added < maxMatches && !stopping) {
  const [next] = db.nextPlayers(1, values.strategy);
  if (!next) {
    console.log('Queue empty — add a seed with --seed.');
    break;
  }
  if (next.depth > maxDepth) {
    db.markPlayerCrawled(next.id);
    continue;
  }

  const history = await client.playerHistory(next.id, { limit: perPlayer });
  let newForPlayer = 0;

  // Unknown matches are processed in parallel: the shared rate limiter keeps
  // the whole batch under the API's cap.
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
    `${next.nickname ?? next.id} (depth ${next.depth}): +${newForPlayer} matches — ` +
      `total ${stats.matches}, vetos ${stats.withVeto}, queue ${stats.pending}`,
  );
}

const final = db.stats();
console.log(
  `\nDone. ${final.matches} matches, ${final.withVeto} of them with veto ` +
    `(${final.vetoEvents} bans), ${final.players} known players, ${final.pending} pending.`,
);
db.close();
