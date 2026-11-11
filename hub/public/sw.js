// Crux hub service worker: lets the page go on the home screen and shows the hub's own notifications (decision 19).
// It caches nothing: the hub is live data, and it only works while the PC is on anyway.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// The push carries only the card's kind, a short title and its id. Details load in the page after the tap.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Crux Hub', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Crux Hub', {
    body: d.body || 'Something needs you.',
    tag: d.card || undefined, // the same card never stacks twice
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: d.url || '/' }
  }));
});

// Tapping opens the card: reuse an open hub window if there is one, else open the hub at the card.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (win) {
      win.postMessage({ type: 'open-card', url });
      return win.focus();
    }
    return self.clients.openWindow(url);
  })());
});
