/* Service Worker — PWAのインストール要件を満たす最小構成のキャッシュ戦略。
 * デプロイのたびに CACHE_VERSION の数字を上げること（v1 -> v2 -> ...）。
 * activate時に旧バージョンのキャッシュを破棄するため、これを忘れると
 * 静的アセットが更新されなくなる。
 *
 * 重要：HTML（ナビゲーション）は絶対にキャッシュ優先にしない。常に
 * ネットワークを優先し、オフライン時のみキャッシュへフォールバックする。
 * デプロイ後に古い画面が端末に残り続ける事故を防ぐため。
 */
const CACHE_VERSION = "wattdokan-v1";

function isStaticAsset(pathname) {
  return pathname.startsWith("/icons/") || /\.(?:wav|png)$/.test(pathname);
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // GET以外・WebSocketアップグレードは素通し
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 他オリジンは素通し
  if (url.pathname === "/cards") return; // カードプールAPIには一切介入しない

  const isNavigation = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isNavigation) {
    // HTML：ネットワーク優先。オフライン時のみキャッシュを返す
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw e;
      }
    })());
    return;
  }

  if (isStaticAsset(url.pathname)) {
    // アイコン・BGM等の静的アセット：キャッシュ優先（重い・変化しないため）
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  // manifest.json等その他は素通し（ブラウザの既定の取得動作に任せる）
});
