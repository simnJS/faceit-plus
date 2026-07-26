// Overlays on veto-phase tiles: both teams' winrate per map.
// Selectors and behavior mirror the live site (FACEIT DOM analysis via
// reverse-engineering of Mappio):
//   - veto tiles: [class^='VetoList__Container'] → card = 1st child of each item
//   - map name inside a card: card.querySelector('div > span')
//   - banned map: the label's computed color switches to rgb(93, 93, 93)
//   - the room may live inside a shadow DOM web component (#parasite-container
//     [id^='MATCHROOM-OVERVIEW']) → search traverses open shadow roots.

import type { TeamMapStat } from './team-map-stats';
import type { Translator } from './i18n';

export const VETO_BADGE_CLASS = 'faceitplus-veto-badge';
const BANNED_LABEL_COLOR = 'rgb(93, 93, 93)';

export interface VetoCard {
  card: HTMLElement;
  label: HTMLElement | null;
  name: string;
}

/** "Dust 2" / "de_dust2" / "Dust2" → "dust2" (matching key). */
export function normalizeMapName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^de[_\s]/, '')
    .replace(/[^a-z0-9]/g, '');
}

// Deep search (shadow roots) is expensive: only attempted when the light DOM
// finds nothing, and at most once every 3s.
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

/**
 * Snapshot of what the page actually contains around the veto.
 *
 * The selectors used come from analyzing another extension, not from direct
 * observation: if FACEIT changed its structure, nothing matches and the
 * feature goes silent. This deliberately broad survey lets us diagnose from
 * evidence instead of guessing.
 */
export function diagnoseVeto(): Record<string, unknown> {
  const survey: Record<string, unknown> = {};
  const classMatches = (needle: string) =>
    [...document.querySelectorAll<HTMLElement>('[class]')]
      .filter((el) => (el.className || '').toString().toLowerCase().includes(needle))
      .slice(0, 8)
      .map((el) => (el.className || '').toString().split(' ')[0]);

  survey.classesVeto = [...new Set(classMatches('veto'))];
  survey.classesPreference = [...new Set(classMatches('preference'))];
  survey.testIds = [
    ...new Set(
      [...document.querySelectorAll('[data-testid]')]
        .map((el) => el.getAttribute('data-testid'))
        .filter((id) => id && /veto|map|preference|vote/i.test(id)),
    ),
  ].slice(0, 12);

  survey.strictContainers = document.querySelectorAll(
    "[class^='VetoList__Container']",
  ).length;
  survey.looseContainers = document.querySelectorAll("[class*='VetoList']").length;
  survey.preferenceTiles = document.querySelectorAll(
    "div[data-testid='matchPreference']",
  ).length;
  survey.activeButtons = document.querySelectorAll(
    "div[data-testid='matchPreference'] button:not([disabled])",
  ).length;
  survey.cardsFound = findVetoCards().length;
  survey.detectedNames = findVetoCards()
    .map((c) => c.name)
    .slice(0, 10);

  // Is there an isolated shadow DOM component that might contain the veto?
  survey.shadowRoots = [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).length;
  return survey;
}

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

/** True if the card's label indicates a banned map (grayed out by FACEIT). */
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
  if (pct >= 20) return '#FF5151'; // high ban probability (Mappio thresholds)
  if (pct >= 10) return '#FBBF24';
  return '#a0a0a0';
}

export interface VetoBadgeOptions {
  faction1: TeamMapStat | undefined;
  faction2: TeamMapStat | undefined;
  banRate: number | null | undefined;
  /** Recommended map to ban (with the winrate delta that justifies it). */
  banAdvice?: { delta: number; fromModel?: boolean } | null;
  /** Probability (%) that this map ends up being played. */
  likelyPercent?: number | null;
  t: Translator;
}

/**
 * Badge placed on a veto tile: team 1 / team 2 winrate (pink / blue border,
 * matching FACEIT's faction colors), the opposing captain's ban probability,
 * and, if applicable, the ban advice or the likely map.
 */
export function createVetoBadge(options: VetoBadgeOptions): HTMLElement {
  const { faction1, faction2, banRate, banAdvice, likelyPercent, t } = options;

  const wrap = document.createElement('div');
  wrap.className = VETO_BADGE_CLASS;
  wrap.style.cssText = [
    'display:flex',
    'flex-wrap:wrap',
    'justify-content:center',
    'gap:4px',
    'margin-top:4px',
    'pointer-events:none', // never intercepts the ban click
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

  const advice = (text: string, tooltip: string, color: string, background: string) => {
    const chip = document.createElement('span');
    chip.textContent = text;
    chip.title = tooltip;
    chip.style.cssText = [
      'flex:1 0 100%',
      'margin-top:3px',
      'padding:3px 4px',
      'text-align:center',
      'border-radius:4px',
      'font-size:9px',
      'letter-spacing:.4px',
      `color:${color}`,
      `background:${background}`,
    ].join(';');
    wrap.appendChild(chip);
  };

  if (banAdvice) {
    const delta = banAdvice.delta;
    advice(
      banAdvice.fromModel && delta >= 0.5
        ? `${t('veto.banAdvice')} +${delta.toFixed(1)}`
        : t('veto.banAdvice'),
      banAdvice.fromModel
        ? t('veto.banAdviceModel', { delta: delta.toFixed(1) })
        : t('veto.banAdviceTooltip', { delta: Math.round(delta) }),
      '#FF5151',
      'rgba(255,81,81,.16)',
    );
  } else if (likelyPercent != null) {
    advice(
      t('veto.likely', { p: likelyPercent }),
      t('veto.likelyTooltip'),
      '#32D35A',
      'rgba(50,211,90,.14)',
    );
  }

  return wrap;
}

