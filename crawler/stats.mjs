import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2] ?? 'crawler/faceit.db');
const one = (sql) => db.prepare(sql).all()[0];
console.log('matches          :', one('SELECT COUNT(1) AS n FROM matches').n);
console.log('  with veto      :', one('SELECT COUNT(1) AS n FROM matches WHERE has_veto = 1').n);
console.log('  with team stats:', one('SELECT COUNT(DISTINCT match_id) AS n FROM match_teams').n);
console.log('bans             :', one('SELECT COUNT(1) AS n FROM veto_events').n);
console.log('players          :', one('SELECT COUNT(1) AS n FROM players').n);
console.log('  known countries:', one("SELECT COUNT(1) AS n FROM players WHERE country IS NOT NULL AND country <> '??'").n);
console.log('  pending        :', one('SELECT COUNT(1) AS n FROM players WHERE crawled_at IS NULL').n);
const top = db
  .prepare(
    "SELECT country, COUNT(1) AS n FROM players WHERE country IS NOT NULL AND country <> '??' GROUP BY country ORDER BY n DESC LIMIT 8",
  )
  .all();
console.log('top countries    :', top.map((r) => `${r.country}:${r.n}`).join(', '));
db.close();
