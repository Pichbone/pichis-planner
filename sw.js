// Pichis Planner – Service Worker
// Bei jeder Änderung an App-Dateien die Versionsnummer erhöhen.
const CACHE = "pp-shell-v0.28.1";

const SHELL = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/config.js",
  "/js/app.js",
  "/js/background.js",
  "/js/tiles.js",
  "/js/repeat.js",
  "/js/shopping.js",
  "/js/todos.js",
  "/js/calendar.js",
  "/js/media.js",
  "/js/messages.js",
  "/js/notify.js",
  "/js/planner.js",
  "/js/notes.js",
  "/js/journal.js",
  "/js/mailin.js",
  "/js/wiki.js",
  "/js/birthdays.js",
  "/js/myday.js",
  "/js/news.js",
  "/js/weather.js",
  "/js/icsimport.js",
  "/js/commute.js",
  "/js/backup.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(SHELL);
    // supabase-js gleich mitnehmen (für den Start ohne Netz); Fehler hier sind nicht schlimm
    try { await c.add(new Request("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2", { mode: "no-cors" })); } catch { /* später */ }
  }));
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
  // Bibliotheken vom CDN (z. B. supabase-js) ebenfalls merken – damit die App auch ohne Netz startet
  const cdn = url.hostname === "cdn.jsdelivr.net" || url.hostname === "cdnjs.cloudflare.com";
  // Sonst nur eigene Dateien cachen – Supabase-Daten immer live laden
  if (url.origin !== self.location.origin && !cdn) return;

  // Erst Netz, bei fehlender Verbindung aus dem Cache
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok || (cdn && res.type === "opaque")) {
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
    // Fremde Adresse (z. B. Apple Karten bei der Fahrtzeit): direkt öffnen, App bleibt, wie sie ist
    if (new URL(target).origin !== self.location.origin) { await self.clients.openWindow(target); return; }
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
