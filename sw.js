// Pichis Planner – Service Worker
// Bei jeder Änderung an App-Dateien die Versionsnummer erhöhen.
const CACHE = "pp-shell-v0.13.0";

const SHELL = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/config.js",
  "/js/app.js",
  "/js/shopping.js",
  "/js/todos.js",
  "/js/calendar.js",
  "/js/media.js",
  "/js/messages.js",
  "/js/notify.js",
  "/js/planner.js",
  "/js/notes.js",
  "/js/journal.js",
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

// ---------- Push-Mitteilungen ----------
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || "Pichis Planner";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || "/" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        try { await c.navigate(target); } catch { c.postMessage({ type: "navigate", url: target }); }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
