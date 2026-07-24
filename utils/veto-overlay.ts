// Overlays sur les tuiles de la phase de veto : winrate des deux équipes par map.
// Sélecteurs et comportements calqués sur ceux du site (analyse du DOM FACEIT via
// le reverse engineering de Mappio) :
//   - tuiles de veto : [class^='VetoList__Container'] → carte = 1er enfant de chaque item
//   - nom de la map dans une carte : card.querySelector('div > span')
//   - map bannie : la couleur calculée du label passe à rgb(93, 93, 93)
//   - la room peut vivre dans un web component shadow DOM (#parasite-container
//     [id^='MATCHROOM-OVERVIEW']) → recherche qui traverse les shadow roots ouverts.

import type { TeamMapStat } from './team-map-stats';
import type { Translator } from './i18n';

export const VETO_BADGE_CLASS = 'faceitplus-veto-badge';
const BANNED_LABEL_COLOR = 'rgb(93, 93, 93)';

export interface VetoCard {
  card: HTMLElement;
  label: HTMLElement | null;
  name: string;
}

/** "Dust 2" / "de_dust2" / "Dust2" → "dust2" (clé de rapprochement). */
export function normalizeMapName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^de[_\s]/, '')
    .replace(/[^a-z0-9]/g, '');
}

// La recherche profonde (shadow roots) est coûteuse : on ne la tente que si le
// light DOM ne donne rien, et au plus toutes les 3 s.
let lastDeepSearch = 0;

function findVetoContainers(): HTMLElement[] {
  const light = document.querySelectorAll<HTMLElement>("[class^='VetoList__Container']");
  if (light.length > 0) return [...light];

  const now = Date.now();
  if (now - lastDeepSearch < 3000) return [];
  lastDeepSearch = now;

  const found: HTMLElement[] = [];
  const walk = (root: ParentNode) => {
    found.push(...root.querySelectorAll<HTMLElement>("[class^='VetoList__Container']"));
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  const scope =
    document.querySelector('#parasite-container') ??
    document.querySelector("[id^='MATCHROOM-OVERVIEW']");
  if (scope) walk(scope);
  return found;
}

/** Toutes les cartes de map du veto visibles, avec leur label et leur nom. */
export function findVetoCards(): VetoCard[] {
  const cards: VetoCard[] = [];
  for (const container of findVetoContainers()) {
    for (const item of container.children) {
      const card = item.children[0] as HTMLElement | undefined;
      if (!card) continue;
      const label = card.querySelector<HTMLElement>('div > span');
      const name = label?.textContent?.trim() ?? '';
      if (name) cards.push({ card, label, name });
    }
  }
  return cards;
}

/** true si le label de la carte indique une map bannie (grisée par FACEIT). */
export function isCardBanned(card: VetoCard): boolean {
  return !!card.label && getComputedStyle(card.label).color === BANNED_LABEL_COLOR;
}

function formatWinrate(stat: TeamMapStat | undefined): string {
  return stat?.winrate == null ? '–' : `${Math.round(stat.winrate)}%`;
}

function winrateColor(stat: TeamMapStat | undefined): string {
  if (stat?.winrate == null) return 'rgba(255,255,255,0.35)';
  if (stat.winrate >= 55) return '#32D35A';
  if (stat.winrate <= 45) return '#FF5151';
  return '#a0a0a0';
}

function banRateColor(pct: number): string {
  if (pct >= 20) return '#FF5151'; // forte proba de ban (seuils Mappio)
  if (pct >= 10) return '#FBBF24';
  return '#a0a0a0';
}

/**
 * Badge posé sur une tuile de veto : winrate équipe 1 / équipe 2 (liseré rose /
 * bleu, couleurs des factions FACEIT) + probabilité de ban du capitaine adverse.
 */
export function createVetoBadge(
  faction1: TeamMapStat | undefined,
  faction2: TeamMapStat | undefined,
  banRate: number | null | undefined,
  t: Translator,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = VETO_BADGE_CLASS;
  if (banRate != null) wrap.dataset.hasBan = '1';
  wrap.style.cssText = [
    'display:flex',
    'justify-content:center',
    'gap:4px',
    'margin-top:4px',
    'pointer-events:none', // ne bloque jamais le clic de ban
    'font:700 10px/1 "Play","Segoe UI",Roboto,Arial,sans-serif',
    'font-variant-numeric:tabular-nums',
  ].join(';');

  const pill = (stat: TeamMapStat | undefined, edge: string, team: string) => {
    const el = document.createElement('span');
    el.textContent = formatWinrate(stat);
    el.title = t('veto.winrateTooltip', { team, games: stat?.games ?? 0 });
    el.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'min-width:34px',
      'padding:4px 5px',
      'background:rgba(0,0,0,0.82)',
      'border-radius:4px',
      `border-left:2px solid ${edge}`,
      `color:${winrateColor(stat)}`,
    ].join(';');
    return el;
  };

  wrap.append(
    pill(faction1, '#d1316a', t('veto.team1')),
    pill(faction2, '#336fe2', t('veto.team2')),
  );

  if (banRate != null) {
    const ban = document.createElement('span');
    ban.textContent = `⛔${banRate}%`;
    ban.title = t('veto.banRateTooltip');
    ban.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'min-width:34px',
      'padding:4px 5px',
      'background:rgba(0,0,0,0.82)',
      'border-radius:4px',
      `color:${banRateColor(banRate)}`,
    ].join(';');
    wrap.appendChild(ban);
  }
  return wrap;
}

