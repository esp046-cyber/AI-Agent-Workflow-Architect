/* AI Agent Workflow Architect — service worker.
 * Lives at the project root so its scope covers the whole app (GitHub Pages friendly).
 * Bump VERSION on every release so clients pick up new files. */
const VERSION = 'aiwa-v1.0.0';
const PRECACHE = [
  './', 'index.html',
  'public/manifest.webmanifest', 'public/offline.html',
  'src/styles.css', 'src/main.js', 'src/state.js', 'src/ui.js', 'src/canvas.js', 'src/inspector.js',
  'src/validatePanel.js', 'src/simulatePanel.js', 'src/codePanel.js',
  'app/config.js', 'app/expr.js', 'app/validator.js', 'app/simulator.js', 'app/codegen.js', 'app/templates.js', 'app/store.js',
  'icons/favicon.svg', 'icons/favicon-32.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/maskable-192.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('aiwa-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Page loads: network first (fresh), fall back to cached shell, then offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('index.html', copy)); return res; })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('public/offline.html'))),
    );
    return;
  }

  // Everything else: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    }),
  );
});
