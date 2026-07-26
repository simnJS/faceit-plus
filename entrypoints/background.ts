import { registerPremierBackground } from '@/utils/premier';

export default defineBackground(() => {
  console.log('[FACEIT+] background started', { id: browser.runtime.id });

  // CORS bridge for csstats.gg: the content script delegates the Premier rating
  // fetch to the service worker (csstats doesn't return ACAO). Requires
  // 'https://csstats.gg/*' in host_permissions (wxt.config.ts).
  registerPremierBackground();

  browser.runtime.onMessage.addListener((message: { type?: string }) => {
    // Dev keepalive ping from the content script: simply receiving a message
    // wakes up the service worker, which re-establishes its connection to the
    // dev server. Nothing else to do here.
    if (message?.type === 'faceitplus:ping') return;
  });
});
