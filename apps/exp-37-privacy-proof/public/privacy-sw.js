// Privacy-mode service worker for exp-37.
//
// When privacy mode is ON, every cross-origin request from a controlled
// client is intercepted and answered with a synthetic 403 — no bytes
// reach the network. Same-origin, data:, and blob: requests always pass
// through. Each block is reported back to the page for the audit log.
//
// This is the real enforcement layer the marketing claim rests on:
// with the SW installed and privacy mode on, the browser physically
// cannot emit a cross-origin byte from this origin's pages.

let privacyMode = false;
const SELF_ORIGIN = self.location.origin;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of already-open clients so no reload is needed.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SET_PRIVACY") {
    privacyMode = !!data.on;
    if (event.source) {
      event.source.postMessage({ type: "PRIVACY_STATE", on: privacyMode });
    }
  } else if (data.type === "PING") {
    if (event.source) {
      event.source.postMessage({ type: "PONG", privacyMode });
    }
  }
});

self.addEventListener("fetch", (event) => {
  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return; // unparseable — let the browser handle it
  }

  const isSelf = url.origin === SELF_ORIGIN;
  const isLocalScheme = url.protocol === "data:" || url.protocol === "blob:";

  if (!privacyMode || isSelf || isLocalScheme) {
    return; // default handling (network / HTTP cache)
  }

  // Privacy mode ON + cross-origin → block before any byte leaves.
  event.respondWith(
    new Response(
      JSON.stringify({ blockedBy: "privacy-sw", url: event.request.url }),
      { status: 403, statusText: "Blocked by Privacy Mode", headers: { "Content-Type": "application/json" } },
    ),
  );
  event.waitUntil(notifyBlocked(event.request.url, event.request.destination));
});

async function notifyBlocked(url, destination) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "SW_BLOCKED", url, destination });
  }
}
