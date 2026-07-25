// Modèle de veto embarqué : prédit le prochain ban, en déduit la map qui sera
// jouée, et recommande le ban qui maximise nos chances.
//
// Les poids sont entraînés hors ligne (voir crawler/) et embarqués tels quels —
// quelques centaines d'octets, aucun serveur, aucune donnée qui sort du navigateur.
//
// ATTENTION : l'ordre et l'échelle des variables doivent rester rigoureusement
// identiques à crawler/lib/model.mjs, sans quoi les poids ne veulent plus rien
// dire. Toute modification doit être faite des deux côtés.

export interface VetoModel {
  version: number;
  maps: string[];
  weights: number[];
  /** Fréquence de ban moyenne par map, tous joueurs confondus. */
  globalRate: Record<string, number>;
}

/** Vécu d'une équipe sur une map : winrate en fraction (0-1) et nombre de matchs. */
export interface MapRecord {
  winrate: number | null;
  games: number;
}

export interface DecisionContext {
  /** Maps encore en jeu. */
  remaining: string[];
  /** Numéro du tour de veto, à partir de 0. */
  step: number;
  /** Vécu de l'équipe qui bannit, par map. */
  banner: Map<string, MapRecord>;
  /** Vécu de l'équipe d'en face, par map. */
  opponent: Map<string, MapRecord>;
  /**
   * Habitude de ban du capitaine qui joue ce tour : proportion de fois où il
   * bannit chaque map quand elle est disponible (même définition qu'à
   * l'entraînement). Absent si le capitaine est inconnu.
   */
  captainRate?: Map<string, number> | null;
}

const CAPTAIN_RATE_BASELINE = 0.15;
/** Poids du prior dans le lissage des habitudes : identique à l'entraînement. */
const CAPTAIN_PRIOR_WEIGHT = 8;

/**
 * Habitude de ban d'un capitaine, lissée vers la moyenne générale quand
 * l'échantillon est mince — même formule qu'à l'entraînement, sans quoi les
 * poids appris ne s'appliqueraient pas à la bonne échelle.
 */
export function captainRatesFromCounts(
  model: VetoModel,
  counts: Record<string, { drops: number; opportunities: number }> | undefined,
  maps: string[],
): Map<string, number> | null {
  if (!counts) return null;
  const rates = new Map<string, number>();
  for (const map of maps) {
    const prior = model.globalRate[map] ?? CAPTAIN_RATE_BASELINE;
    const entry = counts[map];
    const drops = entry?.drops ?? 0;
    const opportunities = entry?.opportunities ?? 0;
    rates.set(
      map,
      (drops + CAPTAIN_PRIOR_WEIGHT * prior) / (opportunities + CAPTAIN_PRIOR_WEIGHT),
    );
  }
  return rates;
}

/** Reproduit exactement le vecteur de variables de l'entraînement. */
function features(model: VetoModel, context: DecisionContext, map: string): number[] {
  const x = new Array<number>(model.maps.length + 8).fill(0);
  const index = model.maps.indexOf(map);
  if (index >= 0) x[index] = 1;

  const base = model.maps.length;
  const banner = context.banner.get(map);
  const opponent = context.opponent.get(map);
  const wrBanner = banner?.winrate ?? null;
  const wrOpponent = opponent?.winrate ?? null;
  const games = banner?.games ?? 0;

  x[base + 0] = wrBanner == null ? 0 : wrBanner - 0.5;
  x[base + 1] = wrOpponent == null ? 0 : wrOpponent - 0.5;
  x[base + 2] = wrBanner == null || wrOpponent == null ? 0 : wrOpponent - wrBanner;
  x[base + 3] = Math.min(1, Math.log1p(games) / 4);
  x[base + 4] = wrBanner == null ? 0 : 1;
  const captain = context.captainRate?.get(map) ?? model.globalRate[map] ?? CAPTAIN_RATE_BASELINE;
  x[base + 5] = captain - CAPTAIN_RATE_BASELINE;
  x[base + 6] = (model.globalRate[map] ?? CAPTAIN_RATE_BASELINE) - CAPTAIN_RATE_BASELINE;
  x[base + 7] = context.step / 6;
  return x;
}

/** Probabilité que chaque map encore en jeu soit la prochaine bannie. */
export function predictBan(
  model: VetoModel,
  context: DecisionContext,
  remaining = context.remaining,
): Map<string, number> {
  const scores = remaining.map((map) => {
    const x = features(model, { ...context, remaining }, map);
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += model.weights[i] * x[i];
    return sum;
  });
  const max = Math.max(...scores);
  const exp = scores.map((s) => Math.exp(s - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return new Map(remaining.map((map, i) => [map, exp[i] / total]));
}

export interface VetoState {
  /** Maps encore en jeu, dans l'ordre du pool. */
  remaining: string[];
  /** Vécu par équipe, indexé par map. */
  ours: Map<string, MapRecord>;
  theirs: Map<string, MapRecord>;
  /** Habitudes du capitaine adverse (le nôtre est supposé suivre le conseil). */
  theirCaptainRate?: Map<string, number> | null;
  /** true si c'est à nous de bannir maintenant. */
  ourTurn: boolean;
  /** Nombre de bans déjà effectués, pour situer le tour. */
  step: number;
}

/**
 * Distribution EXACTE de la map finale, par énumération des sous-ensembles.
 * Le pool ne dépassant pas 8 maps, il y a au plus 256 états : inutile de tirer
 * au sort, on parcourt tout.
 */
export function finalMapDistribution(model: VetoModel, state: VetoState): Map<string, number> {
  const pool = state.remaining;
  const n = pool.length;
  if (n === 0) return new Map();
  if (n === 1) return new Map([[pool[0], 1]]);

  const bit = new Map(pool.map((map, i) => [map, 1 << i]));
  const reach = new Float64Array(1 << n);
  reach[(1 << n) - 1] = 1;

  const popcount = (value: number) => {
    let count = 0;
    let v = value;
    while (v) {
      v &= v - 1;
      count += 1;
    }
    return count;
  };
  const masks = [...Array(1 << n).keys()]
    .filter((m) => m > 0)
    .sort((a, b) => popcount(b) - popcount(a));

  for (const mask of masks) {
    const probability = reach[mask];
    if (probability <= 0) continue;
    const remaining = pool.filter((_, i) => mask & (1 << i));
    if (remaining.length <= 1) continue;

    const banned = n - remaining.length; // bans déjà simulés
    const ourTurn = banned % 2 === 0 ? state.ourTurn : !state.ourTurn;
    const distribution = predictBan(
      model,
      {
        remaining,
        step: state.step + banned,
        banner: ourTurn ? state.ours : state.theirs,
        opponent: ourTurn ? state.theirs : state.ours,
        captainRate: ourTurn ? null : state.theirCaptainRate,
      },
      remaining,
    );
    for (const [map, p] of distribution) {
      reach[mask & ~bit.get(map)!] += probability * p;
    }
  }

  const result = new Map<string, number>();
  for (let i = 0; i < n; i++) if (reach[1 << i] > 0) result.set(pool[i], reach[1 << i]);
  return result;
}

export interface BanRecommendation {
  map: string;
  /** Espérance de valeur si l'on bannit cette map (écart de winrate attendu). */
  value: number;
  /** Gain par rapport au pire choix possible, en points de winrate. */
  gain: number;
  /** Map la plus probable si l'on bannit celle-ci. */
  likelyMap: string | null;
  likelyProbability: number;
}

/** Valeur d'une map pour nous : écart entre notre winrate et le leur. */
function mapValue(state: VetoState, map: string): number {
  const ours = state.ours.get(map)?.winrate;
  const theirs = state.theirs.get(map)?.winrate;
  if (ours == null && theirs == null) return 0;
  return (ours ?? 0.5) - (theirs ?? 0.5);
}

/**
 * Recommande le ban qui maximise notre espérance de victoire.
 *
 * Pour chaque map candidate, on suppose qu'on la bannit, on déroule le reste du
 * veto avec le modèle, et on pondère chaque issue possible par l'avantage
 * qu'elle nous donne. C'est plus fin qu'une règle en un coup : bannir une map
 * que l'adversaire aurait de toute façon bannie ne rapporte rien, et le calcul
 * le voit.
 */
export function recommendBans(model: VetoModel, state: VetoState): BanRecommendation[] {
  if (state.remaining.length <= 1) return [];

  const recommendations: BanRecommendation[] = [];
  for (const candidate of state.remaining) {
    const remaining = state.remaining.filter((m) => m !== candidate);
    const outcome =
      remaining.length === 1
        ? new Map([[remaining[0], 1]])
        : finalMapDistribution(model, {
            ...state,
            remaining,
            step: state.step + 1,
            ourTurn: !state.ourTurn, // c'est ensuite à l'adversaire
          });

    let value = 0;
    let likelyMap: string | null = null;
    let likelyProbability = 0;
    for (const [map, probability] of outcome) {
      value += probability * mapValue(state, map);
      if (probability > likelyProbability) {
        likelyProbability = probability;
        likelyMap = map;
      }
    }
    recommendations.push({ map: candidate, value, gain: 0, likelyMap, likelyProbability });
  }

  recommendations.sort((a, b) => b.value - a.value);
  const worst = recommendations[recommendations.length - 1]?.value ?? 0;
  for (const item of recommendations) item.gain = item.value - worst;
  return recommendations;
}
