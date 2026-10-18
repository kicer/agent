// Agent 任务台 Service Worker
// 策略：HTML 与代码资源(CSS/JS 等)网络优先（保证改动/登录态即时生效），失败回退缓存（离线兜底）；
//       图片与 JSON(manifest/图标，内容稳定)缓存优先，命中本地缓存直接返回，省流量、弱网加载快。
// CACHE_VERSION 仅作缓存命名空间：改 CSS/JS 无需手动升级；改图片/JSON 才需要升它刷新旧缓存。

const CACHE_VERSION = 'agent-v2';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// PRECACHE_URLS: 仅预缓存图片与 JSON——这些是缓存优先的资源，安装时直接落盘秒开，离线也能用。
// HTML/CSS/JS 不预缓存：网络优先策略每次在线都会写入 RUNTIME_CACHE，
// STATIC_CACHE 的旧版反而会在 caches.match() 离线回退时遮蔽更新。
const PRECACHE_URLS = [
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

  // 跳过 API/SSE/预览/交付取件，避免缓存动态数据(预览页需实时；/f/ 同链内容会随重新 save 变化)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sse') || url.pathname.startsWith('/preview') || url.pathname.startsWith('/f/')) return;

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

  // 图片与 JSON（manifest/图标等，内容稳定）：缓存优先，命中即直接返回省流量；
  // 未命中走网络并写入缓存。这类资源改动后需升 CACHE_VERSION 刷新旧缓存。
  if (/\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i.test(url.pathname) || /\.json$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          }
          return resp;
        });
      })
    );
    return;
  }

  // 其余静态资源：网络优先（改完即生效），失败回退缓存（离线/断网可用）
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