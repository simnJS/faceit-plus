import type { PublicPath } from 'wxt/browser';
import {
  CS2_MAP_POOL,
  fetchMatch,
  fetchSelfId,
  getFactionRosters,
  getMapPool,
  getMatchRoster,
  getOpposingLeader,
  getPickedMapIds,
  getRoomMatchId,
  isMatchLive,
  prettyMapName,
  type MapStat,
  type PoolMap,
} from '@/utils/faceit-api';
import { resolveCountries } from '@/utils/country-cache';
import { resolveMapStats } from '@/utils/map-stats-cache';
import { resolvePremierRatings, type PremierInfo } from '@/utils/premier';
import { createPremierBadge } from '@/utils/premier-badge';
import { computeTeamMapStats, type TeamMapStat } from '@/utils/team-map-stats';
import { resolveCaptainBanRates } from '@/utils/ban-rate';
import {
  createVetoBadge,
  findVetoCards,
  isCardBanned,
  normalizeMapName,
  VETO_BADGE_CLASS,
} from '@/utils/veto-overlay';
import { DEFAULT_SETTINGS, getSettings, watchSettings, type Settings } from '@/utils/settings';
import { createTranslator, type Translator } from '@/utils/i18n';
import { resolveRoles } from '@/utils/roles-cache';
import { roleIconSvg, ROLE_GRADIENT, SCORED_ROLES, type RoleResult } from '@/utils/roles';
import { runAutoAccept } from '@/utils/auto-accept';
import { runAutoVeto, type VetoTileCandidate } from '@/utils/auto-veto';
import { mountConfigPanel } from '@/utils/config-panel';

const FLAG_MARKER = 'faceitPlusFlag';
const STATS_MARKER = 'faceitPlusStats';
const STATS_CLASS = 'faceitplus-mapstats';

const MIN_GAMES = 3; // en dessous, l'échantillon n'est pas parlant
const POLL_MS = 4000; // rafraîchissement du pool pendant le veto

export default defineContentScript({
  matches: ['*://*.faceit.com/*'],
  main(ctx) {
    // En dev : quand l'extension se recharge (rebuild WXT), l'ancien content
    // script est invalidé → on recharge la page pour injecter la nouvelle version.
    if (import.meta.env.DEV) {
      ctx.onInvalidated(() => window.location.reload());
      // Le service worker MV3 s'endort après ~30s et perd sa connexion au
      // serveur de dev (donc plus de hot reload). Chaque ping le réveille.
      ctx.setInterval(() => {
        browser.runtime.sendMessage({ type: 'faceitplus:ping' }).catch(() => {});
      }, 10_000);
    }

    let currentRoomId: string | null = null;
    let countryByNickname = new Map<string, string>();
    let premierByNickname = new Map<string, PremierInfo>();
    let statsByNickname = new Map<string, MapStat[]>();
    let roleByNickname = new Map<string, RoleResult>();
    // Stats d'équipe par map (pour les overlays de veto)
    let teamStats: { f1: Map<string, TeamMapStat>; f2: Map<string, TeamMapStat> } | null = null;
    let banRateByMapId: Map<string, number> | null = null;
    let selfFaction: 'faction1' | 'faction2' | null = null;

    // Réglages : chargés au démarrage, mis à jour en direct depuis le panneau.
    let settings: Settings = DEFAULT_SETTINGS;
    let t: Translator = createTranslator(DEFAULT_SETTINGS.lang);
    void getSettings().then((s) => {
      settings = s;
      t = createTranslator(s.lang);
      applyEnrichment();
    });
    const unwatchSettings = watchSettings((s) => {
      settings = s;
      t = createTranslator(s.lang);
      resetInjected(); // ré-applique les toggles d'affichage et la langue
      applyEnrichment();
    });

    mountConfigPanel();

    // Retire nos injections pour que les toggles se ré-appliquent proprement.
    const resetInjected = () => {
      document
        .querySelectorAll('.faceitplus-premier-badge, .faceitplus-mapstats, .faceitplus-veto-badge')
        .forEach((n) => n.remove());
      document.querySelectorAll<HTMLElement>('[data-faceit-plus-flag]').forEach((el) => {
        el.querySelector(':scope > img')?.remove();
        delete el.dataset[FLAG_MARKER];
      });
      document.querySelectorAll<HTMLElement>('[data-faceit-plus-stats]').forEach((el) => {
        delete el.dataset[STATS_MARKER];
      });
    };

    // Pool complet (le plus grand vu depuis l'entrée : ne rétrécit jamais) et
    // maps encore en jeu (rétrécit à chaque ban). Les bannies = full − active.
    let fullPool: PoolMap[] = [];
    let activeIds = new Set<string>();
    let expanded = false; // état du bouton « tout voir », partagé par toutes les cards
    let pollHandle: number | null = null;

    const stopPolling = () => {
      if (pollHandle !== null) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    };

    // FACEIT utilise styled-components : les hash de classes changent à chaque
    // déploiement mais les préfixes sémantiques (Nickname__Name, ListContentPlayer__…)
    // sont stables.
    const applyEnrichment = () => {
      const nameEls = document.querySelectorAll<HTMLElement>('[class*="Nickname__Name"]');
      for (const el of nameEls) {
        const nickname = el.textContent?.trim() ?? '';

        // Drapeau à côté du pseudo
        if (settings.flags && !el.dataset[FLAG_MARKER]) {
          const country = countryByNickname.get(nickname);
          if (country) {
            el.dataset[FLAG_MARKER] = country;
            el.appendChild(createFlagImg(country));
          }
        }

        const card = el.closest<HTMLElement>('[class*="ListContentPlayer__Background"]');

        // Badge rank CS2 Premier devant le niveau FACEIT (no-op si indisponible)
        if (settings.premier && card) {
          placePremierBadge(card, premierByNickname.get(nickname)?.rating);
        }

        // Bandeau sous la card : rôle estimé + K/D par map
        if (card && !card.dataset[STATS_MARKER]) {
          const stats = settings.mapStats ? statsByNickname.get(nickname) : undefined;
          const role = settings.roles ? roleByNickname.get(nickname) : undefined;
          const showStats = Boolean(stats) && fullPool.length > 0;
          if (showStats || role) {
            card.dataset[STATS_MARKER] = '1';
            // La card FACEIT a une hauteur fixe : on la laisse grandir pour que
            // la section reste à l'intérieur du fond sombre arrondi.
            card.style.height = 'auto';
            card.appendChild(createPlayerStrip(showStats ? stats! : null, role ?? null));
          }
        }
      }

      if (settings.vetoStats) applyVetoBadges();

      // Actions automatiques (idempotentes, garde par attribut DOM)
      if (settings.autoAccept.enabled) {
        runAutoAccept(settings.autoAccept.delaySeconds, t);
      }
      if (settings.autoVeto.enabled && currentRoomId) {
        runAutoVeto({
          delaySeconds: settings.autoVeto.delaySeconds,
          chooseBan: chooseBanTarget,
          t,
        });
      }
    };

    // Choix de la map à bannir selon le mode configuré.
    const chooseBanTarget = (candidates: VetoTileCandidate[]): VetoTileCandidate | null => {
      if (settings.autoVeto.mode === 'winrate') {
        const myStats =
          selfFaction === 'faction2' ? teamStats?.f2 : selfFaction === 'faction1' ? teamStats?.f1 : null;
        if (!myStats) return null; // données pas prêtes : on ne fait rien
        const idByNormalized = new Map(fullPool.map((m) => [normalizeMapName(m.name), m.id]));
        let worst: VetoTileCandidate | null = null;
        let worstWinrate = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
          const mapId = idByNormalized.get(candidate.normalized);
          const winrate = mapId ? (myStats.get(mapId)?.winrate ?? -1) : -1;
          if (winrate < worstWinrate) {
            worstWinrate = winrate;
            worst = candidate;
          }
        }
        return worst;
      }
      // mode 'order' : la première map de la liste encore disponible est bannie
      for (const id of settings.autoVeto.order) {
        const normalized = normalizeMapName(id);
        const hit = candidates.find((c) => c.normalized === normalized);
        if (hit) return hit;
      }
      return null;
    };

    // Overlays sur les tuiles de la phase de veto : winrates d'équipe + ban rate.
    const applyVetoBadges = () => {
      if (!teamStats) return;
      const cards = findVetoCards();
      if (cards.length === 0) return;
      const nameToId = new Map(fullPool.map((m) => [normalizeMapName(m.name), m.id]));

      for (const entry of cards) {
        const mapId = nameToId.get(normalizeMapName(entry.name));
        if (!mapId) continue;

        const banRate = banRateByMapId?.get(mapId) ?? null;
        let badge = entry.card.querySelector<HTMLElement>(`:scope > .${VETO_BADGE_CLASS}`);
        // (Re)pose le badge s'il manque, ou si le ban rate est arrivé entre-temps.
        if (badge && banRate != null && !badge.dataset.hasBan) {
          badge.remove();
          badge = null;
        }
        if (!badge) {
          badge = createVetoBadge(teamStats.f1.get(mapId), teamStats.f2.get(mapId), banRate, t);
          entry.card.appendChild(badge);
        }
        // Map bannie par FACEIT → badge estompé
        const banned = isCardBanned(entry);
        badge.style.opacity = banned ? '0.15' : '1';
        badge.style.filter = banned ? 'grayscale(100%)' : '';
      }
    };

    // Retire tous les bandeaux et les réinjecte (après changement de pool / expand).
    const rerenderStrips = () => {
      document.querySelectorAll(`.${STATS_CLASS}`).forEach((n) => n.remove());
      document
        .querySelectorAll<HTMLElement>(`[data-${STATS_MARKER.replace(/([A-Z])/g, '-$1').toLowerCase()}]`)
        .forEach((c) => delete c.dataset[STATS_MARKER]);
      applyEnrichment();
    };

    // Un seul passage par frame, même si le SPA mute le DOM en rafale.
    let applyScheduled = false;
    const scheduleApply = () => {
      if (applyScheduled) return;
      applyScheduled = true;
      requestAnimationFrame(() => {
        applyScheduled = false;
        applyEnrichment();
      });
    };

    // `pool` = maps encore votables (rétrécit avec les bans), `picked` = map(s) finale(s).
    // Actif = la map pick si le veto est conclu, sinon les maps restantes.
    // fullPool (« tout voir ») = pool CS2 courant + tout ce qui a été vu : garanti
    // complet même si la room est déjà passé le veto (entities réduites).
    const updatePool = (pool: PoolMap[], picked: string[]) => {
      const union = new Map<string, PoolMap>();
      for (const m of CS2_MAP_POOL) union.set(m.id, m); // base : 7 maps, dans l'ordre du pool
      for (const m of fullPool) union.set(m.id, m); // conserve ce qui a déjà été vu
      for (const m of pool) union.set(m.id, m); // entities à jour (noms officiels)
      for (const id of picked) if (!union.has(id)) union.set(id, { id, name: prettyMapName(id) });
      fullPool = [...union.values()];

      activeIds = picked.length > 0 ? new Set(picked) : new Set(pool.map((m) => m.id));
    };

    const enterRoom = async (matchId: string) => {
      currentRoomId = matchId;
      stopPolling();
      expanded = false;
      try {
        const match = await fetchMatch(matchId);
        const roster = getMatchRoster(match);
        // Cœur (rapide, endpoints FACEIT) : drapeaux + K/D par map.
        const [countries, statsByUid] = await Promise.all([
          resolveCountries(roster.map((p) => p.nickname)),
          resolveMapStats(roster.map((p) => p.id)),
        ]);
        if (currentRoomId !== matchId) return; // parti ailleurs entre-temps

        updatePool(getMapPool(match), getPickedMapIds(match));
        countryByNickname = countries;
        statsByNickname = new Map(
          roster
            .map((p) => [p.nickname, statsByUid.get(p.id)] as const)
            .filter((pair): pair is [string, MapStat[]] => Boolean(pair[1])),
        );

        // Stats d'équipe par map pour les overlays de veto
        const factions = getFactionRosters(match);
        teamStats = {
          f1: computeTeamMapStats(factions.faction1, statsByUid),
          f2: computeTeamMapStats(factions.faction2, statsByUid),
        };

        console.log(
          `[FACEIT+] cœur prêt (${countries.size} drapeaux, ${statsByNickname.size} rosters, ${fullPool.length} maps)`,
        );
        applyEnrichment();

        // Ban rate du capitaine adverse (jusqu'à ~100 requêtes, cache 6 h) :
        // découplé, n'affiche les % que quand c'est prêt.
        void (async () => {
          const selfId = await fetchSelfId();
          if (!selfId) return;
          selfFaction = factions.faction1.some((p) => p.id === selfId)
            ? 'faction1'
            : factions.faction2.some((p) => p.id === selfId)
              ? 'faction2'
              : null;
          const opposingLeader = getOpposingLeader(match, selfId);
          if (!opposingLeader) return; // spectateur ou leaders absents
          const rates = await resolveCaptainBanRates(
            opposingLeader,
            fullPool.map((m) => m.id),
          );
          if (currentRoomId !== matchId || !rates) return;
          banRateByMapId = new Map(Object.entries(rates.probByMap));
          console.log(
            `[FACEIT+] ban rate prêt (${rates.datasetSize} matchs de capitaine analysés)`,
          );
          applyEnrichment();
        })();

        // Rôles estimés (1 requête lifetime par joueur, cache 24 h) : découplé.
        void resolveRoles(roster.map((p) => p.id))
          .then((rolesByUid) => {
            if (currentRoomId !== matchId) return;
            roleByNickname = new Map(
              roster
                .map((p) => [p.nickname, rolesByUid.get(p.id)] as const)
                .filter((pair): pair is [string, RoleResult] => Boolean(pair[1])),
            );
            rerenderStrips(); // les bandeaux déjà posés doivent intégrer le rôle
          })
          .catch((e) => console.warn('[FACEIT+] rôles indisponibles :', e));

        // Premier (source externe Leetify, plus lente/faillible) : découplé, ne
        // bloque jamais l'affichage du reste.
        void resolvePremierRatings(roster.map((p) => p.nickname))
          .then((premier) => {
            if (currentRoomId !== matchId) return;
            premierByNickname = premier;
            const n = [...premier.values()].filter((v) => v.rating != null).length;
            console.log(`[FACEIT+] Premier : ${n}/${roster.length} joueurs`);
            applyEnrichment();
          })
          .catch((e) => console.warn('[FACEIT+] Premier indisponible :', e));

        // Veto en cours : le pool évolue → on le rafraîchit tant que c'est live.
        if (isMatchLive(match)) {
          pollHandle = ctx.setInterval(() => {
            void pollPool(matchId);
          }, POLL_MS) as unknown as number;
        }
      } catch (error) {
        console.warn('[FACEIT+] enrichissement indisponible :', error);
      }
    };

    const pollPool = async (matchId: string) => {
      if (currentRoomId !== matchId) return stopPolling();
      try {
        const match = await fetchMatch(matchId);
        if (currentRoomId !== matchId) return;
        const before = [...activeIds].sort().join(',');
        updatePool(getMapPool(match), getPickedMapIds(match));
        if ([...activeIds].sort().join(',') !== before) rerenderStrips();
        if (!isMatchLive(match)) stopPolling();
      } catch {
        /* transitoire : on réessaiera au prochain tick */
      }
    };

    const onLocationChange = (url: string | URL) => {
      const matchId = getRoomMatchId(url);
      if (!matchId) {
        currentRoomId = null;
        stopPolling();
        countryByNickname = new Map();
        premierByNickname = new Map();
        statsByNickname = new Map();
        roleByNickname = new Map();
        fullPool = [];
        activeIds = new Set();
        teamStats = null;
        banRateByMapId = null;
        selfFaction = null;
      } else if (matchId !== currentRoomId) {
        void enterRoom(matchId);
      }
    };

    const observer = new MutationObserver(scheduleApply);
    observer.observe(document.body, { childList: true, subtree: true });
    ctx.onInvalidated(() => {
      observer.disconnect();
      stopPolling();
      unwatchSettings();
    });

    ctx.addEventListener(window, 'wxt:locationchange', ({ newUrl }) => onLocationChange(newUrl));
    onLocationChange(location.href);

    /** Rôle estimé : icône + nom en dégradé, détail des scores en infobulle. */
    function createRolePill(result: RoleResult): HTMLElement {
      const pill = document.createElement('span');
      pill.style.cssText = ['display:inline-flex', 'align-items:center', 'gap:4px'].join(';');
      pill.title =
        result.role === 'unknown'
          ? t('role.notEnough')
          : `${result.role.toUpperCase()} — ` +
            SCORED_ROLES.map((r) => `${r} ${result.scores[r]}`).join(' · ');

      pill.innerHTML = roleIconSvg(result.role, 13);

      const label = document.createElement('span');
      label.textContent = result.role === 'unknown' ? t('role.unknown') : result.role.toUpperCase();
      label.style.cssText = [
        'font-size:9.5px',
        'font-weight:800',
        'letter-spacing:.5px',
        'color:transparent',
        `background-image:${ROLE_GRADIENT[result.role]}`,
        '-webkit-background-clip:text',
        'background-clip:text',
      ].join(';');
      pill.appendChild(label);
      return pill;
    }

    /** Bandeau sous la card : rôle estimé puis K/D par map (pool du match). */
    function createPlayerStrip(stats: MapStat[] | null, role: RoleResult | null): HTMLDivElement {
      const byMapId = new Map((stats ?? []).map((s) => [s.map, s]));

      // Extension de la card du joueur : dessine son propre fond sombre (même
      // couleur que la card FACEIT) avec coins arrondis en bas — rendu identique
      // que la card fixe la hauteur ou non. Indentée pour passer à droite des
      // avatars qui débordent sous la card.
      const card = document.createElement('div');
      card.className = STATS_CLASS;
      card.style.cssText = [
        'position:relative',
        'display:flex',
        'align-items:center',
        'flex-wrap:wrap',
        'gap:3px 14px',
        'padding:7px 12px 8px 4px',
        'background:rgb(18,18,18)',
        'border-radius:0 0 8px 8px',
        'font:600 11px/1 "Play","Segoe UI",Roboto,Arial,sans-serif',
        'font-variant-numeric:tabular-nums',
      ].join(';');

      if (role) card.appendChild(createRolePill(role));

      let hiddenCount = 0;
      for (const poolMap of stats ? fullPool : []) {
        const banned = !activeIds.has(poolMap.id);
        if (banned && !expanded) {
          hiddenCount += 1;
          continue;
        }

        const stat = byMapId.get(poolMap.id);
        const enough = stat && stat.games >= MIN_GAMES;

        const chip = document.createElement('span');
        chip.title = banned
          ? t('map.banned', { map: poolMap.name })
          : enough
            ? t('map.kdTooltip', { map: poolMap.name, games: stat!.games })
            : t('map.notEnough', { map: poolMap.name });
        chip.style.cssText = [
          'display:inline-flex',
          'align-items:center',
          'gap:4px',
          banned ? 'opacity:0.45' : '',
        ]
          .filter(Boolean)
          .join(';');

        const label = document.createElement('span');
        label.textContent = mapAbbrev(poolMap.name);
        label.style.cssText = 'color:rgba(255,255,255,0.45);letter-spacing:.4px;';

        const value = document.createElement('span');
        if (enough) {
          value.textContent = stat!.kd.toFixed(2);
          value.style.cssText = `color:${kdColor(stat!.kd)};font-weight:800;`;
        } else {
          value.textContent = '–';
          value.style.color = 'rgba(255,255,255,0.3)';
        }

        chip.append(label, value);
        card.appendChild(chip);
      }

      // Bouton déplier / replier (seulement s'il y a des maps bannies à révéler)
      if (hiddenCount > 0 || expanded) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.textContent = expanded ? t('map.collapseLabel') : `+${hiddenCount}`;
        toggle.title = expanded ? t('map.collapse') : t('map.expand');
        toggle.style.cssText = [
          'display:inline-flex',
          'align-items:center',
          'margin-left:auto',
          'padding:1px 6px',
          'border-radius:4px',
          'border:none',
          'background:rgba(255,255,255,0.06)',
          'cursor:pointer',
          'font:inherit',
          'font-size:10px',
          'color:rgba(255,255,255,0.45)',
        ].join(';');
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          expanded = !expanded;
          rerenderStrips();
        });
        card.appendChild(toggle);
      }

      return card;
    }
  },
});

/** Pose le badge Premier juste avant l'icône de niveau FACEIT (slot de droite). Idempotent. */
function placePremierBadge(card: HTMLElement, rating: number | null | undefined): void {
  if (rating == null || !Number.isFinite(rating) || rating <= 0) return;
  const endSlot = card.querySelector<HTMLElement>('[class*="EndSlotContainer"]');
  if (!endSlot || endSlot.querySelector('.faceitplus-premier-badge')) return;
  const badge = createPremierBadge(rating);
  const level = endSlot.querySelector(':scope > svg'); // icône de niveau FACEIT
  if (level) level.insertAdjacentElement('beforebegin', badge);
  else endSlot.insertBefore(badge, endSlot.firstChild);
}

function createFlagImg(country: string): HTMLImageElement {
  const img = document.createElement('img');
  img.src = browser.runtime.getURL(`/flags/${country}.svg` as PublicPath);
  img.alt = country.toUpperCase();
  img.title = country.toUpperCase();
  img.style.cssText =
    'height:12px;margin-left:6px;vertical-align:-1px;border-radius:2px;display:inline-block;';
  img.addEventListener('error', () => img.remove());
  return img;
}

function mapAbbrev(name: string): string {
  return name.replace(/^de_/i, '').slice(0, 3).toUpperCase();
}

function kdColor(kd: number): string {
  if (kd >= 1.2) return '#3ba55d'; // vert
  if (kd < 1.0) return '#e0564f'; // rouge
  return '#e6c34a'; // jaune (neutre)
}
