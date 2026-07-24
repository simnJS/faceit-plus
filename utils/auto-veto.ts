// Auto-ban de maps pendant le veto (mécanique répliquée de Repeek) :
// « c'est mon tour et je suis capitaine » = FACEIT rend des boutons NON-disabled
// sur les tuiles [data-testid="matchPreference"] — aucune API nécessaire.
// On planifie UN ban à la fois (toast compte à rebours + Annuler), annulé
// automatiquement si le bouton disparaît ou se désactive (tour passé / ban manuel).

import { showCountdownToast } from './toast';
import { normalizeMapName } from './veto-overlay';
import type { Translator } from './i18n';

const TILE_MARKER = 'data-fp-trigger-auto-veto';

// Sélecteurs Repeek (config CDN v13) + fallback plus permissif
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
      // garde-fou : ne jamais cliquer un bouton de pick à la place d'un ban
      if (/pick|choisir/i.test(button.textContent ?? '')) continue;
      out.push({ name, normalized: normalizeMapName(name), tile, button });
    }
  }
  return out;
}

export interface AutoVetoOptions {
  delaySeconds: number;
  /** Choisit la map à bannir parmi les tuiles disponibles, ou null pour ne rien faire. */
  chooseBan: (candidates: VetoTileCandidate[]) => VetoTileCandidate | null;
  t: Translator;
}

/** À appeler à chaque passe du MutationObserver global. Idempotent. */
export function runAutoVeto(options: AutoVetoOptions): void {
  const candidates = findCandidates();
  if (candidates.length === 0) return;
  // Un ban est déjà planifié sur une tuile encore active → ne rien replanifier.
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

  // Annulation auto : bouton disparu ou désactivé (ban manuel, tour passé).
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
