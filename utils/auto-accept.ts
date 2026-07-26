// Auto-accept of the "Match ready" popup (mechanic replicated from Repeek):
// detect the dialog via a multilingual regex on its innerHTML, the Accept
// button = the LAST <button> in the dialog, native .click() after a
// configurable delay, countdown toast + Cancel, DOM-attribute guard against
// double-triggering.

import { showCountdownToast } from './toast';
import type { Translator } from './i18n';

const MARKER = 'data-fp-trigger-auto-accept';

// "Match ready" in FACEIT's 21 languages (extracted from Repeek v5.6.4)
const MATCH_READY = [
  'Match ready',
  '경기 준비',
  'Rozgrywka gotowa',
  'المباراة جاهزة',
  'Zápas připraven',
  'Match bereit',
  'Partida lista',
  'Ottelu valmis',
  'Match prêt',
  'Meč je spreman',
  'A mérkőzés készen áll',
  'Perlawanan sedia',
  '試合を行えます',
  'Натпреварот е подготвен',
  'Partida pronta',
  'Jogo preparado',
  'Матч готов',
  'Match redo',
  'การแข่งขันพร้อมแล้ว',
  'Maç hazır',
  '比赛已就绪',
];
const MATCH_READY_RE = new RegExp(MATCH_READY.join('|'));

const DIALOG_SELECTOR =
  'div[role="dialog"]:has(div[class*="ConfirmationStyledContainer"] > button)';

/** To be called on every pass of the global MutationObserver. Idempotent. */
export function runAutoAccept(delaySeconds: number, t: Translator): void {
  const dialogs = document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR);
  let button: HTMLElement | null = null;
  for (const dialog of dialogs) {
    if (MATCH_READY_RE.test(dialog.innerHTML)) {
      const buttons = dialog.querySelectorAll('button');
      button = (buttons[buttons.length - 1] as HTMLElement) ?? null;
      break;
    }
  }
  if (!button || button.hasAttribute(MARKER)) return;
  button.setAttribute(MARKER, '');

  const target = button;
  const seconds = Math.max(1, Math.round(delaySeconds));
  let cancelled = false;

  const toast = showCountdownToast({
    title: t('toast.matchReady'),
    description: (s) => t('toast.accepting', { s }),
    seconds,
    cancelLabel: t('toast.cancel'),
    onCancel: () => {
      cancelled = true;
      window.clearTimeout(timer);
      watcher.disconnect();
    },
  });

  // If the button disappears (manual click, dialog expired): dismiss the toast.
  const watcher = new MutationObserver(() => {
    if (!target.isConnected) {
      toast.dismiss();
      watcher.disconnect();
    }
  });
  watcher.observe(document.body, { childList: true, subtree: true });

  const timer = window.setTimeout(() => {
    watcher.disconnect();
    toast.dismiss();
    if (!cancelled && target.isConnected) target.click();
  }, seconds * 1000);
}
