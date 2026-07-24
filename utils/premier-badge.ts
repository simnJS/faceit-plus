// Badge rank CS2 Premier — réplique 1:1 du badge de csrep.gg (référence choisie
// par l'utilisateur) : SVG inline `viewBox 0 0 125 40` = tuile arrondie penchée
// (fond sombre du tier + contour), deux stripes obliques à gauche, nombre italique
// gras avec les milliers en 22px et le reste en 20px (unités du viewBox).
// Couleurs extraites des variables CSS --color-premier-* de csrep.gg.

interface Tier {
  min: number;
  color: string; // couleur vive (stripes, contour, texte)
  surface: string; // fond sombre de la tuile
}

const TIERS: Tier[] = [
  { min: 30000, color: '#facc15', surface: '#2a2207' }, // gold
  { min: 25000, color: '#ef4444', surface: '#2f0a0a' }, // red
  { min: 20000, color: '#ec4899', surface: '#2f0a1e' }, // pink
  { min: 15000, color: '#a855f7', surface: '#1e0d30' }, // purple
  { min: 5000, color: '#3b82f6', surface: '#0a1530' }, //  blue
  { min: 0, color: '#9ca3af', surface: '#1d1f25' }, //     gray
];

function tierFor(rating: number): Tier {
  return TIERS.find((t) => rating >= t.min) ?? TIERS[TIERS.length - 1];
}

// Géométrie du badge csrep.gg (extraite de leur SVG, à ne pas modifier)
const TILE_PATH =
  'M10.5449 1H118.411C121.468 1.0002 123.809 3.71928 123.355 6.74219L119.155 34.7422C118.788 37.1895 116.686 38.9999 114.211 39H6.34473C3.28805 38.9998 0.946954 36.2807 1.40039 33.2578L5.60059 5.25781C5.96793 2.81051 8.07017 1.00006 10.5449 1Z';
const STRIPE1_PATH =
  'M4.84496 3.40663C5.13867 1.44855 6.82072 0 8.80071 0H13.356L7.35596 40H4.00071C1.55523 40 -0.317801 37.8251 0.0449613 35.4066L4.84496 3.40663Z';
const STRIPE2_PATH = 'M17.2617 0H26.2617L20.2617 40H11.2617L17.2617 0Z';

const FONT = `Inter, ui-sans-serif, system-ui, 'Segoe UI', Roboto, Arial, sans-serif`;

/**
 * Badge Premier (élément détaché, à insérer soi-même).
 * @param rating rating Premier CS2 (> 0)
 */
export function createPremierBadge(rating: number): HTMLElement {
  const tier = tierFor(rating);
  const formatted = Math.round(rating).toLocaleString('en-US'); // "24,893"
  const commaIdx = formatted.indexOf(',');
  const [big, small] =
    commaIdx === -1
      ? [formatted, '']
      : [formatted.slice(0, commaIdx + 1), formatted.slice(commaIdx + 1)];

  const badge = document.createElement('span');
  badge.className = 'faceitplus-premier-badge';
  badge.title = `CS2 Premier · ${formatted}`;
  badge.style.cssText = [
    'display:inline-flex',
    'width:63px',
    'height:20px',
    'margin-right:10px',
    'vertical-align:middle',
    'cursor:default',
  ].join(';');

  badge.innerHTML = `
    <svg viewBox="0 0 125 40" style="display:block;width:100%;height:100%;overflow:hidden">
      <path d="${TILE_PATH}" fill="${tier.surface}" stroke="${tier.color}" stroke-width="2"></path>
      <path d="${STRIPE1_PATH}" fill="${tier.color}"></path>
      <path d="${STRIPE2_PATH}" fill="${tier.color}"></path>
      <text x="68" y="27" fill="${tier.color}" text-anchor="middle" dominant-baseline="bottom"
            font-style="italic" font-family="${FONT}">
        <tspan font-size="22" font-weight="700">${big}</tspan>${
          small ? `<tspan font-size="20" font-weight="700">${small}</tspan>` : ''
        }
      </text>
    </svg>`;

  return badge;
}
