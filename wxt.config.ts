import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    // The extension is loaded manually into everyday Chrome
    // (chrome://extensions → "Load unpacked" → .output/chrome-mv3-dev).
    // Set disabled to false to go back to the dedicated dev profile Chrome.
    disabled: true,
    chromiumProfile: resolve('.wxt/chrome-data'),
    firefoxProfile: resolve('.wxt/firefox-data'),
    keepProfileChanges: true,
    startUrls: ['https://www.faceit.com'],
  },
  manifest: {
    name: 'FACEIT+',
    description: 'Browser extension that enhances FACEIT',
    permissions: ['storage'],
    // csstats.gg: fetch the Premier rating from the service worker (no CORS on csstats' side).
    host_permissions: ['*://*.faceit.com/*', 'https://csstats.gg/*'],
    browser_specific_settings: {
      gecko: { id: 'faceit-plus@simnjs.fr' },
    },
    web_accessible_resources: [
      { resources: ['flags/*.svg'], matches: ['*://*.faceit.com/*'] },
    ],
  },
});
