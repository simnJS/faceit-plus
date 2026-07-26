import { CS2_MAP_POOL } from './faceit-api';
import type { LangSetting } from './i18n';

// Persistent FACEIT+ settings (storage.local), consumed by the content
// script and editable from the config panel injected into the page.

export interface AutoAcceptSettings {
  enabled: boolean;
  /** Delay (seconds) between the popup appearing and auto-accept. */
  delaySeconds: number;
}

export type AutoVetoMode = 'order' | 'winrate';

export interface AutoVetoSettings {
  enabled: boolean;
  /** 'order' = manual preferences; 'winrate' = ban our worst maps. */
  mode: AutoVetoMode;
  /** Preference order (most preferred first) — bans the least preferred available map. */
  order: string[];
  /** Delay (seconds) before each automatic ban. */
  delaySeconds: number;
}

export interface Settings {
  lang: LangSetting;
  flags: boolean;
  premier: boolean;
  mapStats: boolean;
  roles: boolean;
  smurf: boolean;
  vetoStats: boolean;
  vetoAdvice: boolean;
  autoAccept: AutoAcceptSettings;
  autoVeto: AutoVetoSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'auto',
  flags: true,
  premier: true,
  mapStats: true,
  roles: true,
  smurf: true,
  vetoStats: true,
  vetoAdvice: true,
  autoAccept: { enabled: false, delaySeconds: 2 },
  autoVeto: {
    enabled: false,
    mode: 'order',
    order: CS2_MAP_POOL.map((m) => m.id),
    delaySeconds: 3,
  },
};

const KEY = 'faceitplus:settings';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mergeSettings(stored: DeepPartial<Settings> | undefined): Settings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    autoAccept: { ...DEFAULT_SETTINGS.autoAccept, ...s.autoAccept },
    autoVeto: {
      ...DEFAULT_SETTINGS.autoVeto,
      ...s.autoVeto,
      order: (s.autoVeto?.order ?? DEFAULT_SETTINGS.autoVeto.order).filter(
        (id): id is string => typeof id === 'string',
      ),
    },
  } as Settings;
}

export async function getSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(KEY))[KEY] as DeepPartial<Settings> | undefined;
  return mergeSettings(raw);
}

export async function saveSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = mergeSettings({
    ...current,
    ...patch,
    autoAccept: { ...current.autoAccept, ...patch.autoAccept },
    autoVeto: { ...current.autoVeto, ...patch.autoVeto },
  } as DeepPartial<Settings>);
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

/** Watches for settings changes (other tabs / panel). Returns an unsubscribe function. */
export function watchSettings(callback: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, { newValue?: unknown }>,
    area: string,
  ) => {
    if (area === 'local' && changes[KEY]) {
      callback(mergeSettings(changes[KEY].newValue as DeepPartial<Settings> | undefined));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
