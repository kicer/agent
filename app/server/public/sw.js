// Agent 任务台 Service Worker
// 策略：HTML 与静态资源均网络优先（保证改动/登录态即时生效），失败回退缓存（离线兜底）。
// CACHE_VERSION 仅作缓存命名空间，改动静态资源后无需再手动升级它。

const CACHE_VERSION = 'agent-v2';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const PRECACHE_URLS = [
  '/',
  '/login.html',
  '/css/style.css',
  '/js/core.js',
  '/js/models.js',
  '/js/settings.js',
  '/js/skills.js',
  '/js/tasks.js',
  '/vendor/marked.min.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // addAll 任一失败会整体失败，逐个 add 更稳
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] precache fail', url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 只处理同源
  if (url.origin !== self.location.origin) return;

  // 跳过 API/SSE，避免缓存动态数据
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sse')) return;

  // HTML/登录页：网络优先
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return resp;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/')))
    );
    return;
  }

  // 静态资源：网络优先（改完即生效），失败回退缓存（离线/断网可用）
  event.respondWith(
    fetch(request).then((resp) => {
      if (resp && resp.status === 200 && resp.type === 'basic') {
        const copy = resp.clone();
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
      }
      return resp;
    }).catch(() => caches.match(request))
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});