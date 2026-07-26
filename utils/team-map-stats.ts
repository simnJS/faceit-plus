import type { MapStat, RosterPlayer } from './faceit-api';

export interface TeamMapStat {
  /** Team's aggregated winrate on the map, in % (0-100), or null if no data. */
  winrate: number | null;
  /** Total number of team matches on the map (sum across players). */
  games: number;
}

/**
 * Aggregates a team's per-map stats: sum of wins / sum of games across all
 * roster players (players with no history on a map count as 0).
 */
export function computeTeamMapStats(
  roster: RosterPlayer[],
  statsByUid: Map<string, MapStat[]>,
): Map<string, TeamMapStat> {
  const acc = new Map<string, { wins: number; games: number }>();
  for (const player of roster) {
    for (const stat of statsByUid.get(player.id) ?? []) {
      const entry = acc.get(stat.map) ?? { wins: 0, games: 0 };
      entry.wins += stat.wins;
      entry.games += stat.games;
      acc.set(stat.map, entry);
    }
  }
  const result = new Map<string, TeamMapStat>();
  for (const [map, e] of acc) {
    result.set(map, {
      games: e.games,
      winrate: e.games > 0 ? (e.wins / e.games) * 100 : null,
    });
  }
  return result;
}
