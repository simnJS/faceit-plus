// SQLite storage for the crawler (Node's native module, no dependency).
// The database also holds the progress state: a player whose `crawled_at`
// is null is still in the queue. The crawl can therefore resume at any time.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  nickname      TEXT,
  country       TEXT,
  level         INTEGER,
  elo           INTEGER,
  discovered_at INTEGER NOT NULL,
  crawled_at    INTEGER,
  depth         INTEGER NOT NULL DEFAULT 0,
  -- Number of known matches the player appears in. Maintained on insert:
  -- recomputing it via a join on every pass made the queue unusable.
  seen          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS matches (
  id               TEXT PRIMARY KEY,
  played_at        INTEGER,
  region           TEXT,
  competition      TEXT,
  competition_id   TEXT,
  competition_name TEXT,
  organizer        TEXT,
  game_mode        TEXT,
  best_of          INTEGER,
  calculate_elo    INTEGER,
  status           TEXT,
  configured_at    INTEGER,
  started_at       INTEGER,
  finished_at      INTEGER,
  map_picked       TEXT,
  offered_pool     TEXT,       -- maps offered for the vote, comma-separated
  winner           TEXT,
  score_faction1   INTEGER,
  score_faction2   INTEGER,
  fetched_at       INTEGER NOT NULL,
  has_veto         INTEGER NOT NULL DEFAULT 0
);

-- Per-team context: premade hints (name, type) and FACEIT estimates.
CREATE TABLE IF NOT EXISTS match_teams (
  match_id        TEXT NOT NULL,
  faction         TEXT NOT NULL,
  name            TEXT,
  type            TEXT,        -- "lobby" (matchmaking queue) or a formed team
  rating          REAL,
  win_probability REAL,
  skill_avg       REAL,
  skill_min       INTEGER,
  skill_max       INTEGER,
  PRIMARY KEY (match_id, faction)
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id  TEXT NOT NULL,
  player_id TEXT NOT NULL,
  faction   TEXT,
  is_leader INTEGER NOT NULL DEFAULT 0,
  level     INTEGER,
  elo       INTEGER,
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS veto_events (
  match_id    TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  map         TEXT NOT NULL,
  action      TEXT,
  selected_by TEXT,
  is_random   INTEGER NOT NULL DEFAULT 0,
  round       INTEGER,
  PRIMARY KEY (match_id, order_index)
);
`;

// Indexes are created AFTER the migrations: some cover columns added later,
// and creating them too early would fail on an existing database.
const INDEXES = `
CREATE INDEX IF NOT EXISTS matches_veto ON matches(has_veto);
CREATE INDEX IF NOT EXISTS match_players_player ON match_players(player_id);
CREATE INDEX IF NOT EXISTS players_queue ON players(crawled_at, depth);
CREATE INDEX IF NOT EXISTS players_priority ON players(crawled_at, seen DESC);
`;

// Columns added later on: `CREATE TABLE IF NOT EXISTS` won't add them to an
// existing database, so we add them one by one if they're missing.
const MIGRATIONS = [
  ['matches', 'competition_id', 'TEXT'],
  ['matches', 'competition_name', 'TEXT'],
  ['matches', 'organizer', 'TEXT'],
  ['matches', 'calculate_elo', 'INTEGER'],
  ['matches', 'status', 'TEXT'],
  ['matches', 'configured_at', 'INTEGER'],
  ['matches', 'started_at', 'INTEGER'],
  ['matches', 'finished_at', 'INTEGER'],
  ['matches', 'offered_pool', 'TEXT'],
  ['matches', 'score_faction1', 'INTEGER'],
  ['matches', 'score_faction2', 'INTEGER'],
  ['players', 'seen', 'INTEGER NOT NULL DEFAULT 0'],
];

export class CrawlDb {
  /** @param {string} file path to the SQLite database file */
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    // Safe under WAL mode, and much faster for high-volume writes.
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.#migrate();
    this.db.exec(INDEXES);

    this.stmt = {
      addPlayer: this.db.prepare(
        `INSERT INTO players (id, nickname, country, level, elo, discovered_at, depth)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ),
      markCrawled: this.db.prepare('UPDATE players SET crawled_at = ? WHERE id = ?'),
      // Breadth-first: moves away from the seeds quickly, spreading coverage.
      nextBreadth: this.db.prepare(
        'SELECT id, nickname, depth FROM players WHERE crawled_at IS NULL ORDER BY depth, discovered_at LIMIT ?',
      ),
      // Depth-first: processes players already seen in many known matches
      // first. Their history densifies the database where it's useful —
      // otherwise each captain stays seen two or three times and the veto
      // habit variables have no substance to work with.
      nextDepth: this.db.prepare(
        `SELECT id, nickname, depth, seen FROM players
         WHERE crawled_at IS NULL ORDER BY seen DESC, depth LIMIT ?`,
      ),
      bumpSeen: this.db.prepare('UPDATE players SET seen = seen + 1 WHERE id = ?'),
      hasMatch: this.db.prepare('SELECT 1 FROM matches WHERE id = ?'),
      addMatch: this.db.prepare(
        `INSERT INTO matches (
           id, played_at, region, competition, competition_id, competition_name, organizer,
           game_mode, best_of, calculate_elo, status, configured_at, started_at, finished_at,
           map_picked, offered_pool, winner, score_faction1, score_faction2, fetched_at, has_veto
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET has_veto = excluded.has_veto`,
      ),
      addMatchTeam: this.db.prepare(
        `INSERT INTO match_teams (match_id, faction, name, type, rating, win_probability, skill_avg, skill_min, skill_max)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_id, faction) DO NOTHING`,
      ),
      addMatchPlayer: this.db.prepare(
        `INSERT INTO match_players (match_id, player_id, faction, is_leader, level, elo)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_id, player_id) DO NOTHING`,
      ),
      addVetoEvent: this.db.prepare(
        `INSERT INTO veto_events (match_id, order_index, map, action, selected_by, is_random, round)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_id, order_index) DO NOTHING`,
      ),
    };
  }

  /** Adds missing columns to a database created by an earlier version. */
  #migrate() {
    for (const [table, column, type] of MIGRATIONS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }

    // The `seen` counter was just added: backfill it once from the
    // participations already recorded (the index makes this fast).
    const needsBackfill =
      this.db.prepare('SELECT COUNT(1) AS n FROM players WHERE seen > 0').all()[0].n === 0 &&
      this.db.prepare('SELECT COUNT(1) AS n FROM match_players').all()[0].n > 0;
    if (needsBackfill) {
      process.stdout.write('Initializing participation counter... ');
      const started = Date.now();
      // A single group-by then a join, in one transaction: the correlated
      // subquery version wrote row by row and took an unreasonable amount of
      // time on a database with several tens of thousands of players.
      this.db.exec('BEGIN');
      this.db.exec(`
        UPDATE players SET seen = t.c
        FROM (SELECT player_id, COUNT(1) AS c FROM match_players GROUP BY player_id) AS t
        WHERE players.id = t.player_id
      `);
      this.db.exec('COMMIT');
      console.log(`${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
  }

  /** Adds a player to the queue if not already known. */
  addPlayer({ id, nickname = null, country = null, level = null, elo = null, depth = 0 }) {
    if (!id) return;
    this.stmt.addPlayer.run(id, nickname, country, level, elo, Date.now(), depth);
  }

  markPlayerCrawled(id) {
    this.stmt.markCrawled.run(Date.now(), id);
  }

  nextPlayers(limit = 1, strategy = 'depth') {
    return strategy === 'breadth'
      ? this.stmt.nextBreadth.all(limit)
      : this.stmt.nextDepth.all(limit);
  }

  hasMatch(id) {
    return this.stmt.hasMatch.all(id).length > 0;
  }

  /** Saves a match, its teams, its players, and its veto in a single transaction. */
  saveMatch(match, players, vetoEvents, teams = []) {
    this.db.exec('BEGIN');
    try {
      this.stmt.addMatch.run(
        match.id,
        match.playedAt ?? null,
        match.region ?? null,
        match.competition ?? null,
        match.competitionId ?? null,
        match.competitionName ?? null,
        match.organizer ?? null,
        match.gameMode ?? null,
        match.bestOf ?? null,
        match.calculateElo == null ? null : match.calculateElo ? 1 : 0,
        match.status ?? null,
        match.configuredAt ?? null,
        match.startedAt ?? null,
        match.finishedAt ?? null,
        match.mapPicked ?? null,
        match.offeredPool ?? null,
        match.winner ?? null,
        match.scoreFaction1 ?? null,
        match.scoreFaction2 ?? null,
        Date.now(),
        vetoEvents?.length ? 1 : 0,
      );
      for (const team of teams) {
        this.stmt.addMatchTeam.run(
          match.id,
          team.faction,
          team.name ?? null,
          team.type ?? null,
          team.rating ?? null,
          team.winProbability ?? null,
          team.skillAvg ?? null,
          team.skillMin ?? null,
          team.skillMax ?? null,
        );
      }
      for (const p of players) {
        this.stmt.addMatchPlayer.run(
          match.id,
          p.id,
          p.faction ?? null,
          p.isLeader ? 1 : 0,
          p.level ?? null,
          p.elo ?? null,
        );
        this.stmt.bumpSeen.run(p.id); // keeps the priority queue up to date
      }
      for (const [index, event] of (vetoEvents ?? []).entries()) {
        this.stmt.addVetoEvent.run(
          match.id,
          index,
          event.map,
          event.action ?? null,
          event.selectedBy ?? null,
          event.isRandom ? 1 : 0,
          event.round ?? null,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).all()[0] ?? {};
    return {
      players: one('SELECT COUNT(*) AS n FROM players').n ?? 0,
      pending: one('SELECT COUNT(*) AS n FROM players WHERE crawled_at IS NULL').n ?? 0,
      matches: one('SELECT COUNT(*) AS n FROM matches').n ?? 0,
      withVeto: one('SELECT COUNT(*) AS n FROM matches WHERE has_veto = 1').n ?? 0,
      vetoEvents: one('SELECT COUNT(*) AS n FROM veto_events').n ?? 0,
    };
  }

  close() {
    this.db.close();
  }
}
