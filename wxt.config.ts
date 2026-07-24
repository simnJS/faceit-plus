import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    // L'extension est chargée manuellement dans le Chrome quotidien
    // (chrome://extensions → « Charger l'extension non empaquetée » → .output/chrome-mv3-dev).
    // Passer disabled à false pour revenir au Chrome de dev à profil dédié.
    disabled: true,
    chromiumProfile: resolve('.wxt/chrome-data'),
    firefoxProfile: resolve('.wxt/firefox-data'),
    keepProfileChanges: true,
    startUrls: ['https://www.faceit.com'],
  },
  manifest: {
    name: 'FACEIT+',
    description: 'Extension navigateur qui enrichit FACEIT',
    permissions: ['storage'],
    // csstats.gg : fetch du rating Premier depuis le service worker (pas de CORS côté csstats).
    host_permissions: ['*://*.faceit.com/*', 'https://csstats.gg/*'],
    browser_specific_settings: {
      gecko: { id: 'faceit-plus@simnjs.fr' },
    },
    web_accessible_resources: [
      { resources: ['flags/*.svg'], matches: ['*://*.faceit.com/*'] },
    ],
  },
});
