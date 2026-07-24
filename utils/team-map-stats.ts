import type { MapStat, RosterPlayer } from './faceit-api';

export interface TeamMapStat {
  /** Winrate agrégé de l'équipe sur la map, en % (0-100), ou null si aucune donnée. */
  winrate: number | null;
  /** Nombre total de matchs de l'équipe sur la map (somme des joueurs). */
  games: number;
}

/**
 * Agrège les stats par map d'une équipe : somme des wins / somme des games de
 * tous les joueurs du roster (les joueurs sans historique sur une map comptent 0).
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
