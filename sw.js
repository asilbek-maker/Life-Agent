// Life Agent offline worker. The version changes with every build so phones pick up updates.
const CACHE = "life-agent-81acf875";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./exlib.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "./favicon-64.png", "./widget.html"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("life-agent-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const fresh = req.mode === "navigate" || /\.(html|json|webmanifest)$/.test(url.pathname) || url.pathname.endsWith("/");
  if (fresh) {
    // Network first, so new versions arrive; the cache is the offline fallback.
    e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))));
    return;
  }
  // Photos and icons: cache first, then keep them for offline use.
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })));
});
