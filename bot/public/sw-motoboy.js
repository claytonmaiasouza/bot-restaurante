const CACHE = 'motoboy-v1';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(['/motoboy.html', '/socket.io/socket.io.js']))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// Network-first: tenta rede, cai no cache se offline
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && e.request.url.includes('/motoboy.html')) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Push notifications ────────────────────────────────────────────────────────

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || '🛵 Nova entrega!', {
      body: data.body || 'Acesse o painel para ver os detalhes.',
      icon: data.icon || '/icons/motoboy-icon.svg',
      badge: data.badge || '/icons/motoboy-icon.svg',
      tag: data.tag || 'entrega',
      renotify: true,
      vibrate: [200, 100, 200, 100, 200],
      data: { url: data.url || self.location.origin + '/motoboy.html' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || self.location.origin + '/motoboy.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('motoboy') && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
