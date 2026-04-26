const CACHE = "bookshelf-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // jsdelivr CDN（OpenCC 簡繁轉換器）：cache-first，下載一次後永久使用
  if (url.host === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.match(e.request).then((r) => {
        if (r) return r;
        return fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // Google Books API / 封面圖：先網路後快取
  if (
    url.host === "www.googleapis.com" ||
    url.host.endsWith("googleusercontent.com") ||
    url.host.endsWith("books.google.com") ||
    url.host.endsWith("books.googleusercontent.com")
  ) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 應用本身：先快取後網路
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
