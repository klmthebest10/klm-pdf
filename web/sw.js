/* KLM PDF — service worker (offline) */
const VERSION = 'klmpdf-v1.3.0';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/app.js', 'js/pdfcrypt.js', 'js/ttf.js', 'js/redact.js', 'js/scan.js', 'js/print.js',
  'lib/pdf-lib.min.js', 'lib/jszip.min.js', 'lib/pdfjs/pdf.min.mjs', 'lib/pdfjs/pdf.worker.min.mjs',
  'icons/icon-32.png', 'icons/icon-128.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/file-pdf.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Library & aset statis: cache dulu (cmaps, font, wasm dimuat sesuai kebutuhan lalu disimpan)
  if (url.pathname.includes('/lib/') || url.pathname.includes('/icons/') || url.pathname.includes('/fonts/')) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  // Halaman & kode aplikasi: jaringan dulu (agar selalu terbaru), cadangan dari cache saat offline
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))));
});
