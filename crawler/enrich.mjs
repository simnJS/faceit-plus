// Player profile enrichment: a match roster doesn't include the country, so
// it takes one request per player. This runs separately so it doesn't slow
// down the crawl, and only once per player since the country doesn't change.
//
//   npm run crawl:enrich -- --limit 2000
//
// Note: the elo fetched here is TODAY's elo, not the match's. It's stored for
// reference only and must not be used as a model feature — for that,
// `match_players.level` is captured at match time instead.

import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { FaceitClient, RateLimiter } from './lib/faceit.mjs';

try {
  process.loadEnvFile();
} catch {
  // no .env file: fall back to shell env vars
}

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: 'crawler/faceit.db' },
    limit: { type: 'string', default: '1000' },
    rps: { type: 'string', default: '3' },
  },
});

const apiKey = process.env.FACEIT_API_KEY;
if (!apiKey) {
  console.error('FACEIT_API_KEY is missing: set it in .env.');
  process.exit(1);
}

const db = new DatabaseSync(values.db);
const client = new FaceitClient({
  apiKey,
  limiter: new RateLimiter(Number(values.rps)),
  onLog: (msg) => console.log(msg),
});

const pending = db
  .prepare('SELECT id, nickname FROM players WHERE country IS NULL LIMIT ?')
  .all(Number(values.limit));

const update = db.prepare(
  'UPDATE players SET country = ?, level = COALESCE(?, level), elo = COALESCE(?, elo) WHERE id = ?',
);

let stopping = false;
process.on('SIGINT', () => {
  console.log('\nStop requested...');
  stopping = true;
});

console.log(`${pending.length} player(s) to enrich.`);
let done = 0;
let failed = 0;

for (const player of pending) {
  if (stopping) break;
  const profile = await client.playerById(player.id);
  if (!profile?.player_id) {
    // Deleted or missing account: mark it so we don't keep retrying it.
    update.run('??', null, null, player.id);
    failed += 1;
    continue;
  }
  update.run(
    profile.country ?? '??',
    profile.games?.cs2?.skill_level ?? null,
    profile.games?.cs2?.faceit_elo ?? null,
    player.id,
  );
  done += 1;
  if (done % 50 === 0) console.log(`  ${done}/${pending.length}`);
}

const remaining = db.prepare('SELECT COUNT(*) AS n FROM players WHERE country IS NULL').all()[0].n;
console.log(`Done: ${done} enriched, ${failed} not found, ${remaining} remaining.`);
db.close();
