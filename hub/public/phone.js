// Phone side of the hub (decisions 18 and 19): home-screen install, notifications, and opening the card a
// notification points at. Plain ES module; app.js passes in how to read the current view and open a card.
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
});

const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && isSecureContext;

function keyBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export function initPhone({ button, view, openCard }) {
  let reg = null;
  if ('serviceWorker' in navigator && isSecureContext) {
    navigator.serviceWorker.register('/sw.js').then(r => { reg = r; return refresh(); }).catch(() => { });
    // A tap on a notification while the hub is already open: the service worker hands us the card.
    navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'open-card') fromUrl(e.data.url); });
  }

  // ---------- the bell ----------
  button.hidden = false;
  async function current() { return reg ? reg.pushManager.getSubscription() : null; }
  async function refresh() {
    const sub = await current().catch(() => null);
    let on = false;
    if (sub && Notification.permission === 'granted') on = (await post('/api/push/status', { endpoint: sub.endpoint }).catch(() => ({}))).subscribed;
    button.classList.toggle('on', !!on);
    button.title = on ? 'Notifications are on for this device' : 'Get a notification here when a card needs you';
    button.setAttribute('aria-label', button.title);
  }

  button.addEventListener('click', async () => {
    try {
      if (!canPush) {
        if (!isSecureContext) return alert('Notifications need the secure address. Open the hub through its Tailscale https address (see the hub README).');
        if (ios && !standalone) return alert('On iPhone, add the hub to your home screen first: tap Share, then Add to Home Screen. Open Crux from the home screen and tap the bell again.');
        return alert('This browser cannot show notifications from the hub.');
      }
      if (!reg) reg = await navigator.serviceWorker.ready;
      const sub = await current();
      if (sub && button.classList.contains('on')) {
        if (!confirm('Turn off notifications on this device?')) return;
        await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
        return refresh();
      }
      // iOS only asks for permission from a tap, which this is.
      if (await Notification.requestPermission() !== 'granted') return alert('Notifications are blocked for the hub. Allow them in the phone settings for Crux, then tap the bell again.');
      const { publicKey } = await fetch('/api/push/key').then(r => r.json());
      const fresh = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      await post('/api/push/subscribe', { subscription: fresh.toJSON(), label: ios ? 'iPhone' : (/Android/.test(navigator.userAgent) ? 'Android' : 'Browser') });
      await refresh();
      await post('/api/push/test', {});
    } catch (e) { alert(e.message); }
  });

  // ---------- presence: so a card you are already looking at does not buzz your phone ----------
  const client = sessionStorage.getItem('crux-hub:client') || Math.random().toString(36).slice(2);
  sessionStorage.setItem('crux-hub:client', client);
  let lastInput = Date.now(), timer = 0;
  for (const t of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(t, () => { lastInput = Date.now(); }, { passive: true, capture: true });
  const report = () => {
    clearTimeout(timer);
    const visible = document.visibilityState === 'visible';
    post('/api/presence', { client, ...view(), visible, focused: document.hasFocus(), idleMs: Date.now() - lastInput }).catch(() => { });
    if (visible) timer = setTimeout(report, 20000);
  };
  document.addEventListener('visibilitychange', report);
  addEventListener('focus', report);
  addEventListener('blur', report);
  addEventListener('pagehide', () => navigator.sendBeacon?.('/api/presence', new Blob([JSON.stringify({ client, gone: true })], { type: 'application/json' })));

  // ---------- deep links: /?project=<name>&card=<kind:id> ----------
  function fromUrl(href) {
    const u = new URL(href, location.href);
    const card = u.searchParams.get('card');
    if (card) openCard(u.searchParams.get('project'), card);
    if (u.search && location.search) history.replaceState(null, '', location.pathname);
  }

  // ---------- stale notifications: a card settled elsewhere (on the PC, by the orchestrator) leaves the lock screen ----------
  // waiting(tag) says whether the card a notification points at still waits for you. Run when the page shows and
  // whenever the hub settles something.
  let staleTimer = 0;
  function clearSettled(waiting) {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(async () => {
      if (!reg?.getNotifications) return;
      for (const n of await reg.getNotifications().catch(() => [])) if (n.tag && !waiting(n.tag)) n.close();
    }, 300);
  }

  return { viewChanged: report, openFromLocation: () => fromUrl(location.href), clearSettled };
}
