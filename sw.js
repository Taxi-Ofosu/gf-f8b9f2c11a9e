/* Service worker: de app opent ook bij slechte verbinding (eerst netwerk, anders de laatste versie). */
const CACHE = "goudfib-v3";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const isShell = url.origin === location.origin;
  if (e.request.method !== "GET" || !isShell) return; // koersdata altijd vers ophalen
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
