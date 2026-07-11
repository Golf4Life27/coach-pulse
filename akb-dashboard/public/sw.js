// Minimal service worker for PWA installability. Network-first, no caching
// of API responses — the cockpit's contract is "never render stale
// anything", so the worker exists for install/offline-shell semantics only.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", () => {
  // Pass-through: the browser handles the request; nothing is cached.
});
