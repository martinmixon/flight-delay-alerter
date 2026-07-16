// Service worker: cache-first for the app shell, network-first (with cache
// fallback) for data.json — so the PWA installs, loads offline, and always
// prefers fresh risk data when online.

const CACHE = "flight-delay-alerter-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isData = url.pathname.endsWith("/data.json") || url.pathname.endsWith("data.json");

  if (isData) {
    // Network-first: fetch fresh, cache a copy, fall back to cache offline.
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put("./data.json", copy));
          return res;
        })
        .catch(() => caches.match("./data.json"))
    );
    return;
  }

  // Cache-first for the shell.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
