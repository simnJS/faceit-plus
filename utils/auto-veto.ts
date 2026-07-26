// Auto-ban of maps during veto (mechanic replicated from Repeek):
// "it's my turn and I'm captain" = FACEIT renders NON-disabled buttons on the
// [data-testid="matchPreference"] tiles — no API needed.
// We schedule ONE ban at a time (countdown toast + Cancel), automatically
// cancelled if the button disappears or gets disabled (turn passed / manual ban).

import { showCountdownToast } from './toast';
import { normalizeMapName } from './veto-overlay';
import type { Translator } from './i18n';

const TILE_MARKER = 'data-fp-trigger-auto-veto';

// Repeek selectors (CDN config v13) + more permissive fallback
const CONTAINER_STRICT =
  'div[class*="Veto__Container"] div[class*="VetoList__Container"]:has(div[src*="/games/"]):has(button)';
const CONTAINER_LOOSE = 'div[class*="VetoList__Container"]:has(button)';
const ITEMS = 'div[data-testid="matchPreference"]:has(button:not([disabled]))';
const ITEM_NAME = 'div[class*="styles__MiddleSlotWrapper"] span[class*="styles__Name"]';

export interface VetoTileCandidate {
  name: string;
  normalized: string;
  tile: HTMLElement;
  button: HTMLButtonElement;
}

function findCandidates(): VetoTileCandidate[] {
  const strict = document.querySelectorAll<HTMLElement>(CONTAINER_STRICT);
  const containers = strict.length
    ? [...strict]
    : [...document.querySelectorAll<HTMLElement>(CONTAINER_LOOSE)];

  const out: VetoTileCandidate[] = [];
  for (const container of containers) {
    for (const tile of container.querySelectorAll<HTMLElement>(ITEMS)) {
      const nameEl =
        tile.querySelector<HTMLElement>(ITEM_NAME) ??
        tile.querySelector<HTMLElement>('span[class*="Name"]');
      const name = nameEl?.textContent?.trim() ?? '';
      const button = tile.querySelector<HTMLButtonElement>('button:not([disabled])');
      if (!name || !button) continue;
      // safeguard: never click a pick button instead of a ban button
      if (/pick|choisir/i.test(button.textContent ?? '')) continue;
      out.push({ name, normalized: normalizeMapName(name), tile, button });
    }
  }
  return out;
}

export interface AutoVetoOptions {
  delaySeconds: number;
  /** Picks the map to ban among the available tiles, or null to do nothing. */
  chooseBan: (candidates: VetoTileCandidate[]) => VetoTileCandidate | null;
  t: Translator;
}

/** To be called on every pass of the global MutationObserver. Idempotent. */
export function runAutoVeto(options: AutoVetoOptions): void {
  const candidates = findCandidates();
  if (candidates.length === 0) return;
  // A ban is already scheduled on a still-active tile -> don't reschedule.
  if (candidates.some((c) => c.tile.hasAttribute(TILE_MARKER))) return;

  const target = options.chooseBan(candidates);
  if (!target) return;
  target.tile.setAttribute(TILE_MARKER, '');

  const seconds = Math.max(1, Math.round(options.delaySeconds));
  let cancelled = false;

  const toast = showCountdownToast({
    title: options.t('toast.autoBan'),
    description: (s) => options.t('toast.banning', { map: target.name, s }),
    seconds,
    cancelLabel: options.t('toast.cancel'),
    onCancel: () => {
      cancelled = true;
      window.clearTimeout(timer);
      watcher.disconnect();
    },
  });

  // Auto-cancel: button gone or disabled (manual ban, turn passed).
  const watcher = new MutationObserver(() => {
    if (!target.button.isConnected || target.button.disabled) {
      toast.dismiss();
      watcher.disconnect();
      window.clearTimeout(timer);
    }
  });
  watcher.observe(target.tile, { childList: true, subtree: true, attributes: true });

  const timer = window.setTimeout(() => {
    watcher.disconnect();
    toast.dismiss();
    if (!cancelled && target.button.isConnected && !target.button.disabled) {
      target.button.click();
    }
  }, seconds * 1000);
}
