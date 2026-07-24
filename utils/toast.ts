// Toasts in-page de FACEIT+ (coin bas-droit) : compte à rebours + bouton Annuler.
// Utilisés par l'auto-accept et l'auto-veto pour laisser à l'utilisateur le temps
// d'annuler une action automatique.

const CONTAINER_ID = 'faceitplus-toasts';

function ensureContainer(): HTMLElement {
  let container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:70px', // au-dessus du bouton de config FACEIT+
      'z-index:999999',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
      'font-family:"Play","Segoe UI",Roboto,Arial,sans-serif',
    ].join(';');
    document.body.appendChild(container);
  }
  return container;
}

export interface ToastHandle {
  dismiss(): void;
}

export interface CountdownToastOptions {
  title: string;
  /** Description en fonction des secondes restantes, ex. (s) => `Acceptation dans ${s}s…` */
  description: (secondsLeft: number) => string;
  seconds: number;
  cancelLabel: string;
  onCancel: () => void;
}

export function showCountdownToast(options: CountdownToastOptions): ToastHandle {
  const card = document.createElement('div');
  card.style.cssText = [
    'min-width:240px',
    'max-width:300px',
    'background:#141414',
    'border:1px solid #2c2c2c',
    'border-left:3px solid #ff5500', // accent FACEIT
    'border-radius:8px',
    'padding:10px 12px',
    'box-shadow:0 8px 30px rgba(0,0,0,.55)',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = options.title;
  title.style.cssText = 'font-size:12px;font-weight:700;color:#fff;margin-bottom:3px;';

  const desc = document.createElement('div');
  desc.style.cssText = 'font-size:11px;color:rgba(255,255,255,.6);';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = options.cancelLabel;
  cancel.style.cssText = [
    'margin-top:8px',
    'padding:4px 12px',
    'border:1px solid rgba(255,255,255,.18)',
    'border-radius:5px',
    'background:transparent',
    'color:#fff',
    'font:700 11px "Play","Segoe UI",Roboto,Arial,sans-serif',
    'cursor:pointer',
  ].join(';');

  card.append(title, desc, cancel);
  ensureContainer().appendChild(card);

  let secondsLeft = options.seconds;
  const render = () => {
    desc.textContent = options.description(secondsLeft);
  };
  render();

  const interval = window.setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      window.clearInterval(interval);
      return;
    }
    render();
  }, 1000);

  const dismiss = () => {
    window.clearInterval(interval);
    card.remove();
  };

  cancel.addEventListener('click', () => {
    options.onCancel();
    dismiss();
  });

  return { dismiss };
}
