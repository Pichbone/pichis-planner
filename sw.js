// Pichis Planner – Service Worker
// Bei jeder Änderung an App-Dateien die Versionsnummer erhöhen.
const CACHE = "pp-shell-v0.1.0";

const SHELL = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/config.js",
  "/js/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Nur eigene Dateien cachen – Supabase-Daten immer live laden
  if (url.origin !== self.location.origin) return;

  // Erst Netz, bei fehlender Verbindung aus dem Cache
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req)
          .then(hit => hit || (req.mode === "navigate" ? caches.match("/index.html") : null))
          .then(res => res || Response.error())
      )
  );
});
