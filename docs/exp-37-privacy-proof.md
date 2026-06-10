# Exp-37 · Provable Privacy Mode

## Goal

Demonstrate, in code and in the network panel, that an entire editing
session (import → AI analysis → export) produces **zero outbound
bytes**. Provide a "Privacy Mode" toggle that installs a service-worker
egress lockdown (cross-origin fetches refused with a synthetic 403) and
an audit panel that lists every intercepted fetch attempt for the
session. A static `Content-Security-Policy: connect-src 'self'` ships on
every route as the defence-in-depth layer behind the runtime SW.

## App Location

`apps/exp-37-privacy-proof/`

## Why This Matters — Competitive Edge

Every cloud editor's "we take privacy seriously" copy is unverifiable.
ReelForge is the only browser editor that can lock egress at the
*service-worker* layer and let the user *watch* the network tab during
a 60-minute deposition edit while it stays at zero bytes out.

This is the single highest-leverage marketing differentiator we can ship,
and it costs almost nothing.

See [`research-competitive-edge.md`](./research-competitive-edge.md) §37.

## Key APIs

| API | Where used |
|---|---|
| Service Worker `fetch` event | Intercept and block egress (runtime proof) |
| `Content-Security-Policy: connect-src 'self'` (response header) | Browser-side egress lock (static defence-in-depth) |
| `Reporting-Endpoints` + `Report-To` | CSP violation reports captured locally |
| `PerformanceObserver({ type: "resource" })` | Audit of every initiated request |
| `Storage Buckets` (Chrome 122+) | Per-project quota separation (optional) |
| `Permissions-Policy` | Disable geolocation / mic / camera unless asked |

## Lockdown layers

1. **Build-time:** all dependencies vendored; no runtime CDN; no
   third-party fonts (Geist Mono is local).
2. **Response headers:** a static CSP ships on every route with
   `connect-src 'self'` (set in `next.config.ts`). This is the
   defence-in-depth layer: it blocks all cross-origin egress
   declaratively, independent of the toggle, and is *not* tightened to
   `'none'` because a global `'none'` would break Next.js same-origin
   fetches, RSC navigation, and dev/HMR — `'self'` keeps the app working
   while still proving no third-party egress. COOP/COEP stay set for
   `SharedArrayBuffer` / WebGPU. The privacy *toggle* is enforced at the
   service-worker layer (below), not by mutating the CSP at runtime.
3. **Service worker:** intercepts every `fetch` and rejects anything not
   in the allowlist. Returns a synthetic 403 with a JSON body the audit
   UI can render. This is the *runtime* proof the user watches live in
   the Network panel, and it is what the privacy toggle flips.
4. **CSP report-only fallback:** for the marketing site, ship the same
   CSP report-only so the dev team gets violation reports without
   breaking the app.
5. **Runtime audit panel:** `PerformanceObserver` records every fetch
   attempt with timestamp, URL, initiator stack, and outcome.

## Success Criteria

1. Open the page, click "Privacy Mode on," import a 1-GB clip, run
   captions (exp-26) + auto-reframe (exp-34) + export (exp-10). DevTools
   Network panel shows: only the initial HTML/JS/CSS/model-weight
   requests (which can be CC-zero or pre-cached), and **zero** during
   the session.
2. Audit panel lists 0 outbound requests during the session.
3. Service worker logs every rejected fetch with a stack trace pointing
   at the offending caller; commit-blocker CI rule fails the build if
   the count > 0 on a clean run.
4. CSP violation reports are captured locally — there is no remote
   `report-uri`; the `Reporting-Endpoints` value points at a
   `same-origin` worker that stores violations in IndexedDB.
5. Toggle off → the SW stops refusing cross-origin fetches (a probe
   request reaches the network and shows up as outbound in the audit
   panel). The static CSP is unchanged by the toggle; a marketing /
   analytics surface would relax `connect-src` per-route, scoped away
   from the editor.

## Foot-guns

- Third-party fonts, captchas, analytics, error reporters — all of
  these break cross-origin egress under `connect-src 'self'`. That is the
  point for the editor route; auth and marketing pages would relax the
  CSP per-route. Do not tighten to `connect-src 'none'` globally — it
  also blocks same-origin fetches and Next.js dev/HMR and would break the
  app itself.
- WebSockets count as `connect-src`; the editor must not open any.
- Service Worker registration itself is a fetch — make sure it's
  registered *before* CSP tightens (one-time bootstrap).
- Model weights are large and need cache pre-warming. They count as a
  fetch the first time. Either ship them in the SW pre-cache list (so
  privacy mode shows zero after the first load), or surface a one-time
  "download models" step that the user explicitly consents to.
- Network panel screenshots are the marketing artifact. Make sure the
  page does not load `favicon.ico` from outside `'self'`.

## Demo

- Big "Privacy Mode" toggle.
- A live counter: "Outbound bytes this session: 0."
- A panel listing every fetch attempt (with timestamp + initiator),
  separating "allowed (same-origin)", "allowed (model cache hit)", and
  "blocked".
- Side-by-side "Privacy Mode off" comparison showing what *would* have
  been called (analytics, etc.) had it been disabled.
- A "Generate privacy attestation" button bundles the audit log + CSP
  config + service-worker hash into a signed JSON the user can hand to
  their compliance team.
