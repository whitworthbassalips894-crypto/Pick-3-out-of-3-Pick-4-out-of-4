/**
 * Service Worker · 离线缓存与版本升级
 *
 * 设计目标（对应线上「一直加载中…」故障）：
 *  1. 缓存名带构建版本号 → 每次发版必然换缓存，旧缓存在 activate 阶段被清理，
 *     不会再出现「旧 JS/CSS 与新 HTML 混用」导致的初始化中断。
 *  2. 应用外壳（HTML / JS / CSS / manifest）走「网络优先 + 缓存兜底」，
 *     并在请求上追加版本参数绕开 HTTP 缓存，保证线上拿到的永远是同一批新文件。
 *  3. 开奖底库（data/draws.js|json）走「缓存优先 + 后台更新」，兼顾首屏速度与数据新鲜度。
 *  4. install 阶段逐个缓存、单个失败不阻断安装 → 不会再出现因某个 404 导致 SW 安装失败、用户永远拿不到新版本。
 *  5. 提供 message 通道，供页面查询版本 / 主动跳过等待 / 清空缓存。
 *
 * 注意：BUILD_ID 必须与 src/constants.js 的 APP_BUILD、index.html 里的 ?v= 参数保持一致，
 *      由 tests/build-version.test.mjs 自动校验。
 */

const BUILD_ID = '2026.10.26-r9';
const CACHE_PREFIX = 'mark6-pick3-pick4-';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;

/** 需要离线可用的应用外壳文件（相对 SW 自身路径解析，兼容子目录部署） */
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/styles.css',
  './assets/icon.svg',
  './src/constants.js',
  './src/combinatorics.js',
  './src/parser.js',
  './src/strategy.js',
  './src/dailyfive.js',
  './src/statistics.js',
  './src/storage.js',
  './src/sync.js',
  './src/copy.js',
  './src/app.js',
  './data/draws.js',
  './data/draws.json'
];

/**
 * 底库文件：缓存优先 + 后台更新（体积大，且旧一点不影响正确性）
 * ⚠ 必须用相对路径：站点若部署在子目录（例如 /repo/），绝对路径 /data/draws.js 会 404。
 */
const DATA_FILES = ['./data/draws.js', './data/draws.json'];

/** 把 pathname 归一化：/xxx/index.html 与 /xxx/ 视为同一个入口 */
function normalizePath(pathname) {
  if (pathname.endsWith('/index.html')) return pathname.slice(0, -'index.html'.length);
  return pathname;
}

/** 解析相对路径（相对 SW 自身 scope），得到归一化 pathname */
function resolvePath(relative) {
  const url = new URL(relative, self.location.href);
  return normalizePath(url.pathname);
}

const SHELL_PATHS = new Set([
  ...SHELL_FILES.map(resolvePath),
  ...DATA_FILES.map(resolvePath)
]);

const DATA_PATH_SET = new Set(DATA_FILES.map(resolvePath));

/** 缓存键统一使用「origin + 归一化 pathname」，忽略查询参数，避免 ?v= 造成缓存分裂 */
function cacheKeyFor(url) {
  return `${url.origin}${normalizePath(url.pathname)}`;
}

/** 给请求追加版本参数，强制绕过 HTTP 缓存拿到最新文件 */
function bustedUrl(url) {
  const u = new URL(url.toString());
  u.searchParams.set('sw', BUILD_ID);
  return u.toString();
}

/**
 * 统一的网络请求参数：
 *  - sw=<BUILD_ID> 让每次发版都产生新的 URL，天然绕开 HTTP 缓存
 *  - Cache-Control: no-cache 要求回源校验，避免拿到 10 分钟内的旧副本
 */
const NETWORK_OPTS = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 逐个缓存：单个文件失败（例如尚未部署的新文件）不应该让整个安装失败
      await Promise.all(
        SHELL_FILES.map(async (file) => {
          try {
            const url = new URL(file, self.location.href);
            const res = await fetch(bustedUrl(url), NETWORK_OPTS);
            if (!res || !res.ok) return;
            await cache.put(cacheKeyFor(url), res.clone());
          } catch {
            /* 单个资源失败忽略，运行时仍有网络兜底 */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // 只清理本工具自己的历史缓存（以 CACHE_PREFIX 开头）。
      // ⚠ 不能用 includes('mark6') 之类的宽条件：同一个 Pages 源下可能还部署着别的工具，
      //    误删它们的缓存会让那些页面直接白屏。
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k.startsWith(CACHE_PREFIX))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'GET_VERSION') {
    const reply = { type: 'VERSION', build: BUILD_ID, cache: CACHE_NAME };
    if (event.source) event.source.postMessage(reply);
    else if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    return;
  }
  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        // 同样只清理本工具前缀的缓存，绝不碰同域其它工具的数据
        await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
        const reply = { type: 'CACHES_CLEARED' };
        if (event.source) event.source.postMessage(reply);
      })()
    );
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = normalizePath(url.pathname);
  const key = cacheKeyFor(url);

  // 底库：缓存优先 + 后台更新
  // ⚠ 带 `_r=` 参数的请求（例如页面上的「重新读取数据源」）必须直连网络，
  //    否则用户永远拿到旧缓存里的底库，同步功能形同虚设。
  if (DATA_PATH_SET.has(path)) {
    const forceNetwork = url.searchParams.has('_r');
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(key);
        const network = fetch(bustedUrl(url), NETWORK_OPTS)
          .then((res) => {
            if (res && res.ok) cache.put(key, res.clone());
            return res;
          })
          .catch(() => null);
        if (forceNetwork) {
          const fresh = await network;
          if (fresh) return fresh;
          if (cached) return cached;
          return new Response('离线且无本地缓存', { status: 503, statusText: 'offline' });
        }
        if (cached) {
          network.catch(() => {});
          return cached;
        }
        const fresh = await network;
        return fresh || new Response('离线且无本地缓存', { status: 503, statusText: 'offline' });
      })()
    );
    return;
  }

  // 应用外壳：网络优先 + 缓存兜底（保证 HTML/JS/CSS 永远来自同一批版本）
  if (SHELL_PATHS.has(path)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const res = await fetch(bustedUrl(url), NETWORK_OPTS);
          if (res && res.ok) {
            cache.put(key, res.clone());
          }
          return res;
        } catch {
          const cached = await cache.match(key);
          if (cached) return cached;
          return new Response(
            `离线且没有缓存副本（构建 ${BUILD_ID}）。请联网后刷新，或点击页面上的「修复缓存」。`,
            { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
          );
        }
      })()
    );
    return;
  }

  // 同源其它资源：缓存优先 + 后台更新
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        network.catch(() => {});
        return cached;
      }
      const fresh = await network;
      return fresh || new Response('', { status: 504, statusText: 'offline' });
    })()
  );
});
