// Enrichissement des profils joueurs : le roster d'un match ne contient pas le
// pays, il faut une requête par joueur. On la fait à part pour ne pas ralentir le
// crawl, et une seule fois par joueur puisque le pays ne change pas.
//
//   npm run crawl:enrich -- --limit 2000
//
// Note : l'elo récupéré ici est celui d'AUJOURD'HUI, pas celui du match. Il est
// stocké à titre indicatif mais ne doit pas servir de variable au modèle — pour
// ça, `match_players.level` est capturé au moment du match, lui.

import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { FaceitClient, RateLimiter } from './lib/faceit.mjs';

try {
  process.loadEnvFile();
} catch {
  // pas de .env : variables du shell
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
  console.error('FACEIT_API_KEY manquante : renseigne-la dans .env.');
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
  console.log('\nArrêt demandé…');
  stopping = true;
});

console.log(`${pending.length} joueur(s) à enrichir.`);
let done = 0;
let failed = 0;

for (const player of pending) {
  if (stopping) break;
  const profile = await client.playerById(player.id);
  if (!profile?.player_id) {
    // Compte supprimé ou introuvable : on marque pour ne pas y revenir sans cesse.
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
console.log(`Terminé : ${done} enrichis, ${failed} introuvables, ${remaining} restants.`);
db.close();
