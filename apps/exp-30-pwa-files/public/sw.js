// Minimal Service Worker — required for PWA installability in Chromium
// but deliberately caches nothing. This experiment is about install + file
// handlers + share target, not offline.

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass everything through to the network.
self.addEventListener("fetch", () => {
  // no-op
});
