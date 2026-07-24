// Panneau de configuration FACEIT+ : pastille flottante en bas à droite qui
// ouvre un panneau de réglages dans la page. Les écritures passent par
// saveSettings → le content script réagit en direct via watchSettings.

import { CS2_MAP_POOL, prettyMapName } from './faceit-api';
import { createTranslator, type LangSetting, type Translator } from './i18n';
import { getSettings, saveSettings, type Settings } from './settings';

const BUTTON_ID = 'faceitplus-config-btn';
const PANEL_ID = 'faceitplus-config-panel';
const STYLE_ID = 'faceitplus-config-style';

type Patch = Parameters<typeof saveSettings>[0];

const CSS = `
#${BUTTON_ID}{
  position:fixed; right:18px; bottom:18px; z-index:999997;
  width:42px; height:42px; padding:0; border-radius:13px;
  display:flex; align-items:center; justify-content:center;
  border:1px solid #2a2a30; background:linear-gradient(180deg,#1b1b1f 0%,#121215 100%);
  box-shadow:0 6px 20px rgba(0,0,0,.5); cursor:pointer;
  font:800 15px/1 "Play","Segoe UI",Roboto,Arial,sans-serif; letter-spacing:-.3px;
  color:#f2f2f2; transition:transform .18s ease, border-color .18s ease;
}
#${BUTTON_ID}:hover{ transform:translateY(-2px); border-color:#3a3a42; }
#${BUTTON_ID} i{ font-style:normal; color:#ff5500; }
#${BUTTON_ID}[data-open="1"]{ border-color:#ff5500; }

#${PANEL_ID}{
  position:fixed; right:18px; bottom:70px; z-index:999998;
  width:250px; max-height:70vh; overflow-y:auto; overscroll-behavior:contain;
  background:#0e0e11; border:1px solid #26262c; border-radius:16px;
  box-shadow:0 20px 60px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.02) inset;
  font-family:"Play","Segoe UI",Roboto,Arial,sans-serif; color:#ececec;
  animation:fp-rise .18s cubic-bezier(.2,.8,.3,1);
}
@keyframes fp-rise{ from{ opacity:0; transform:translateY(10px) } }
@media (prefers-reduced-motion:reduce){ #${PANEL_ID}{ animation:none } #${BUTTON_ID}{ transition:none } }
#${PANEL_ID}::-webkit-scrollbar{ width:8px }
#${PANEL_ID}::-webkit-scrollbar-thumb{ background:#2a2a30; border-radius:8px; border:2px solid #0e0e11 }

#${PANEL_ID} .fp-head{
  position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:6px;
  padding:9px 11px; background:linear-gradient(180deg,#131317 0%,#0e0e11 100%);
  border-bottom:1px solid #1f1f24;
}
#${PANEL_ID} .fp-brand{ font-weight:800; font-size:12.5px; letter-spacing:-.2px }
#${PANEL_ID} .fp-brand i{ font-style:normal; color:#ff5500 }
#${PANEL_ID} .fp-x{
  margin-left:auto; width:20px; height:20px; padding:0; border:none; border-radius:6px;
  background:transparent; color:#7a7a86; cursor:pointer; font-size:12px; line-height:1;
  transition:background .15s ease, color .15s ease;
}
#${PANEL_ID} .fp-x:hover{ background:#1c1c22; color:#e8e8e8 }

#${PANEL_ID} .fp-sec{ padding:8px 11px }
#${PANEL_ID} .fp-sec + .fp-sec{ border-top:1px solid #18181d }
#${PANEL_ID} .fp-sec-t{
  font-size:9px; font-weight:700; letter-spacing:.8px; text-transform:uppercase;
  color:#5a5a66; margin-bottom:3px;
}
#${PANEL_ID} .fp-row{
  display:flex; align-items:center; gap:10px; padding:5px 0; cursor:pointer;
}
#${PANEL_ID} .fp-lbl{ flex:1; min-width:0; font-size:12px; font-weight:600; color:#e2e2e8 }

/* Interrupteur */
#${PANEL_ID} .fp-sw{ position:relative; flex:0 0 auto; width:30px; height:17px }
#${PANEL_ID} .fp-sw input{ position:absolute; opacity:0; width:0; height:0 }
#${PANEL_ID} .fp-sw i{
  position:absolute; inset:0; border-radius:20px; background:#26262d;
  border:1px solid #33333c; transition:background .18s ease, border-color .18s ease;
}
#${PANEL_ID} .fp-sw i::after{
  content:''; position:absolute; top:2px; left:2px; width:11px; height:11px; border-radius:50%;
  background:#8a8a95; transition:transform .18s cubic-bezier(.2,.8,.3,1), background .18s ease;
}
#${PANEL_ID} .fp-sw input:checked + i{ background:rgba(255,85,0,.22); border-color:#ff5500 }
#${PANEL_ID} .fp-sw input:checked + i::after{ transform:translateX(13px); background:#ff5500 }
#${PANEL_ID} .fp-sw input:focus-visible + i{ outline:2px solid #ff5500; outline-offset:2px }

/* Curseur */
#${PANEL_ID} .fp-slide{ padding:3px 0 6px }
#${PANEL_ID} .fp-slide-h{ display:flex; align-items:baseline; margin-bottom:5px }
#${PANEL_ID} .fp-slide-h b{ flex:1; font-size:12px; font-weight:600; color:#e2e2e8 }
#${PANEL_ID} .fp-val{
  font-size:12px; font-weight:800; color:#ff5500; font-variant-numeric:tabular-nums;
}
#${PANEL_ID} input[type=range]{
  -webkit-appearance:none; appearance:none; width:100%; height:4px; border-radius:4px;
  background:#26262d; outline:none; cursor:pointer;
}
#${PANEL_ID} input[type=range]::-webkit-slider-thumb{
  -webkit-appearance:none; width:14px; height:14px; border-radius:50%; background:#ff5500;
  border:2px solid #0e0e11; box-shadow:0 0 0 1px #ff5500; cursor:pointer;
}
#${PANEL_ID} input[type=range]::-moz-range-thumb{
  width:12px; height:12px; border-radius:50%; background:#ff5500; border:2px solid #0e0e11; cursor:pointer;
}

/* Sélecteur segmenté */
#${PANEL_ID} .fp-seg{ display:flex; gap:2px; padding:2px; background:#161619; border-radius:7px; margin:2px 0 4px }
#${PANEL_ID} .fp-seg button{
  flex:1; padding:4px 3px; border:none; border-radius:5px; background:transparent; cursor:pointer;
  font:600 10.5px "Play","Segoe UI",Roboto,Arial,sans-serif; color:#7c7c88;
  transition:background .15s ease, color .15s ease;
}
#${PANEL_ID} .fp-seg button:hover{ color:#c9c9d2 }
#${PANEL_ID} .fp-seg button[data-on="1"]{ background:rgba(255,85,0,.14); color:#ff7a33 }

/* Liste ordonnée des maps */
#${PANEL_ID} .fp-maps{ padding-top:2px }
#${PANEL_ID} .fp-map{
  display:flex; align-items:center; gap:7px; padding:3px 6px; margin-bottom:2px;
  background:#141418; border:1px solid #1e1e24; border-radius:6px;
  transition:border-color .15s ease, background .15s ease;
}
#${PANEL_ID} .fp-map:hover{ background:#17171c; border-color:#2b2b33 }
#${PANEL_ID} .fp-map em{
  flex:0 0 auto; width:15px; height:15px; border-radius:4px; background:#1f1f26;
  display:flex; align-items:center; justify-content:center;
  font:700 9px "Play",sans-serif; font-style:normal; color:#7a7a86;
}
#${PANEL_ID} .fp-map:first-child em{ background:rgba(255,85,0,.16); color:#ff7a33 }
#${PANEL_ID} .fp-map b{ flex:1; font-size:11.5px; font-weight:600; color:#dcdce2 }
#${PANEL_ID} .fp-map button{
  width:17px; height:17px; padding:0; border:none; border-radius:4px; background:transparent;
  color:#4d4d57; cursor:pointer; font-size:7px; line-height:1;
  transition:background .15s ease, color .15s ease;
}
#${PANEL_ID} .fp-map button:hover:not(:disabled){ background:#22222a; color:#ff7a33 }
#${PANEL_ID} .fp-map button:disabled{ opacity:.25; cursor:default }
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

export function mountConfigPanel(): void {
  if (document.getElementById(BUTTON_ID) || !document.body) return;
  injectStyle();

  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.innerHTML = 'F<i>+</i>';

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.display = 'none';

  const close = () => {
    panel.style.display = 'none';
    button.dataset.open = '0';
  };
  const open = () => {
    panel.style.display = 'block';
    button.dataset.open = '1';
    void render(panel, close);
  };

  button.addEventListener('click', () => {
    panel.style.display === 'none' ? open() : close();
  });
  document.addEventListener('click', (event) => {
    const target = event.target as Node | null;
    if (panel.style.display === 'none' || !target) return;
    if (!panel.contains(target) && !button.contains(target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.style.display !== 'none') close();
  });

  document.body.append(button, panel);
}

async function render(panel: HTMLElement, close: () => void): Promise<void> {
  const settings = await getSettings();
  const t = createTranslator(settings.lang);
  panel.replaceChildren();

  const update = async (patch: Patch) => {
    await saveSettings(patch);
    void render(panel, close);
  };

  // En-tête
  const head = el('div', 'fp-head');
  head.innerHTML = `<span class="fp-brand">FACEIT<i>+</i></span>`;
  const x = el('button', 'fp-x');
  x.type = 'button';
  x.textContent = '✕';
  x.title = t('panel.close');
  x.addEventListener('click', close);
  head.appendChild(x);
  panel.appendChild(head);

  // Affichage
  const display = section(t('section.display'));
  display.append(
    toggle(t('display.flags'), settings.flags, (v) => update({ flags: v })),
    toggle(t('display.premier'), settings.premier, (v) => update({ premier: v })),
    toggle(t('display.mapStats'), settings.mapStats, (v) => update({ mapStats: v })),
    toggle(t('display.roles'), settings.roles, (v) => update({ roles: v })),
    toggle(t('display.vetoStats'), settings.vetoStats, (v) => update({ vetoStats: v })),
  );
  panel.appendChild(display);

  // Auto-accept
  const accept = section(t('section.autoAccept'));
  accept.append(
    toggle(t('common.enable'), settings.autoAccept.enabled, (v) =>
      update({ autoAccept: { enabled: v } }),
    ),
  );
  if (settings.autoAccept.enabled) {
    accept.appendChild(
      slider(t('common.delay'), t('common.seconds'), settings.autoAccept.delaySeconds, 1, 10, (v) =>
        update({ autoAccept: { delaySeconds: v } }),
      ),
    );
  }
  panel.appendChild(accept);

  // Auto-veto
  const veto = section(t('section.autoVeto'));
  veto.append(
    toggle(t('common.enable'), settings.autoVeto.enabled, (v) =>
      update({ autoVeto: { enabled: v } }),
    ),
  );
  if (settings.autoVeto.enabled) {
    veto.append(
      slider(t('common.delay'), t('common.seconds'), settings.autoVeto.delaySeconds, 1, 20, (v) =>
        update({ autoVeto: { delaySeconds: v } }),
      ),
      segmented(
        [
          { value: 'order', label: t('autoVeto.mode.order') },
          { value: 'winrate', label: t('autoVeto.mode.winrate') },
        ],
        settings.autoVeto.mode,
        (v) => update({ autoVeto: { mode: v as Settings['autoVeto']['mode'] } }),
      ),
    );
    if (settings.autoVeto.mode === 'order') veto.appendChild(mapOrder(settings, update));
  }
  panel.appendChild(veto);

  // Langue
  const language = section(t('section.language'));
  language.appendChild(
    segmented(
      [
        { value: 'auto', label: t('lang.auto') },
        { value: 'fr', label: 'FR' },
        { value: 'en', label: 'EN' },
      ],
      settings.lang,
      (v) => update({ lang: v as LangSetting }),
    ),
  );
  panel.appendChild(language);
}

// ── Primitives ─────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function section(title: string): HTMLElement {
  const wrap = el('div', 'fp-sec');
  const heading = el('div', 'fp-sec-t');
  heading.textContent = title;
  wrap.appendChild(heading);
  return wrap;
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = el('label', 'fp-row');
  const text = el('div', 'fp-lbl');
  text.textContent = label;

  const sw = el('span', 'fp-sw');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  sw.append(input, el('i'));

  row.append(text, sw);
  return row;
}

function slider(
  label: string,
  unit: string,
  value: number,
  min: number,
  max: number,
  onCommit: (v: number) => void,
): HTMLElement {
  const wrap = el('div', 'fp-slide');
  const head = el('div', 'fp-slide-h');
  const name = el('b');
  name.textContent = label;
  const val = el('span', 'fp-val');
  val.textContent = `${value} ${unit}`;
  head.append(name, val);

  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.value = String(value);
  input.addEventListener('input', () => {
    val.textContent = `${input.value} ${unit}`;
  });
  input.addEventListener('change', () => onCommit(Number(input.value)));

  wrap.append(head, input);
  return wrap;
}

function segmented(
  options: Array<{ value: string; label: string }>,
  current: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = el('div', 'fp-seg');
  for (const option of options) {
    const button = el('button');
    button.type = 'button';
    button.textContent = option.label;
    if (current === option.value) button.dataset.on = '1';
    button.addEventListener('click', () => onChange(option.value));
    wrap.appendChild(button);
  }
  return wrap;
}

/** Liste ordonnée des maps à bannir (la 1re est bannie en premier). */
function mapOrder(settings: Settings, update: (patch: Patch) => Promise<void>): HTMLElement {
  const wrap = el('div', 'fp-maps');
  const order = [
    ...settings.autoVeto.order,
    ...CS2_MAP_POOL.map((m) => m.id).filter((id) => !settings.autoVeto.order.includes(id)),
  ];

  order.forEach((id, index) => {
    const row = el('div', 'fp-map');
    const rank = el('em');
    rank.textContent = String(index + 1);
    const name = el('b');
    name.textContent = prettyMapName(id);
    row.append(rank, name);

    const move = (delta: number) => {
      const next = [...order];
      const target = index + delta;
      if (target < 0 || target >= next.length) return;
      [next[index], next[target]] = [next[target], next[index]];
      void update({ autoVeto: { order: next } });
    };
    for (const [symbol, delta, disabled] of [
      ['▲', -1, index === 0],
      ['▼', 1, index === order.length - 1],
    ] as const) {
      const button = el('button');
      button.type = 'button';
      button.textContent = symbol;
      button.disabled = disabled;
      button.addEventListener('click', () => move(delta));
      row.appendChild(button);
    }
    wrap.appendChild(row);
  });
  return wrap;
}
