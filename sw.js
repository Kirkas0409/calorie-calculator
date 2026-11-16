// 拍照熱量計算機 service worker
// 靜態資源用版本化快取（更新時會清掉舊版）；CDN / Hugging Face 模型另存，避免更新網頁時重抓 88 MB。
const STATIC_CACHE = 'calapp-static-v4';
const CDN_CACHE = 'calapp-cdn';
const KEEP = new Set([STATIC_CACHE, CDN_CACHE, 'transformers-cache']);

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon.png',
  './favicon.ico'
];

function isNav(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return req.destination === 'document' || accept.includes('text/html');
}

function isCdnHost(h) {
  return h === 'cdn.jsdelivr.net'
    || h === 'huggingface.co'
    || h.endsWith('.huggingface.co')
    || h === 'hf.co'
    || h.endsWith('.hf.co')
    || h.endsWith('.xethub.hf.co');
}

async function networkFirstNav(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone());
      cache.put(new Request('./index.html'), fresh.clone());
      cache.put(new Request('./'), fresh.clone());
    }
    return fresh;
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true }))
      || (await cache.match('./index.html'))
      || (await cache.match('./'))
      || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: true });
  const fetching = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await fetching) || Response.error();
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  // 只快取完整的 200，避免把 Range / 錯誤回應存起來
  if (res && res.ok && res.status === 200) cache.put(req, res.clone());
  return res;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(PRECACHE);
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && (event.data === 'SKIP_WAITING' || event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Range 請求交給瀏覽器／模型載入器處理，避免破壞大型模型分片下載
  if (req.headers.has('range')) return;

  if (url.origin === self.location.origin) {
    if (isNav(req) || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
      event.respondWith(networkFirstNav(req));
      return;
    }
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  if (isCdnHost(url.hostname)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
  }
});
