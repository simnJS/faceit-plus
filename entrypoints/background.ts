import { registerPremierBackground } from '@/utils/premier';

export default defineBackground(() => {
  console.log('[FACEIT+] background démarré', { id: browser.runtime.id });

  // Pont CORS pour csstats.gg : le content script délègue au service worker le fetch
  // du rating Premier (csstats ne renvoie pas d'ACAO). Requiert 'https://csstats.gg/*'
  // dans host_permissions (wxt.config.ts).
  registerPremierBackground();

  browser.runtime.onMessage.addListener((message: { type?: string }) => {
    // Ping keepalive du content script en dev : le simple fait de recevoir un
    // message réveille le service worker, qui rétablit sa connexion au serveur
    // de dev. Rien d'autre à faire.
    if (message?.type === 'faceitplus:ping') return;
  });
});
