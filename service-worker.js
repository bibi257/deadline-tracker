// 締切トラッカー用 Service Worker
// 目的：初回アクセス後は電波が悪い/圏外でもアプリを開けるようにする。
// データそのものはlocalStorageにあるので、ここではアプリの「殻」だけキャッシュする。
//
// キャッシュ名を変えると古いキャッシュは自動で破棄される。
// 中身（index.html等）を大きく更新したときは、この名前も変えると確実に切り替わる。
const CACHE_NAME = "deadline-tracker-v3";
const CORE_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

// 方針：まずネットワークを試し、取れなければキャッシュ、それも無ければ諦める。
// アプリ自身が「最新版かどうか」をfetchで確認する仕組みを持っているため、
// Service Workerはキャッシュ優先にせず、常に最新を優先しつつオフライン時だけ助ける。
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // 外部リソース（フォント等）には関与しない

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // 正常な応答だけを保存する。更新確認用の「?_=時刻」などクエリ付きのURLは
        // 毎回別物として溜まり続けるので、クエリを外した1件として上書き保存する
        if (res.ok) {
          const copy = res.clone();
          const key = url.origin + url.pathname;
          caches.open(CACHE_NAME).then((cache) => cache.put(key, copy));
        }
        return res;
      })
      // オフライン時は、?export=all などクエリ付きで開かれても同じページを返す
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
