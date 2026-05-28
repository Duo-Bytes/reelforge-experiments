# exp-37-privacy-proof · Provable Privacy Mode

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **Every cloud editor's unverifiable 'we take privacy seriously' copy**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-37-privacy-proof.md`](../../docs/exp-37-privacy-proof.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-37-privacy-proof dev
```

## Status

v2 — real enforcement. `public/privacy-sw.js` is a working service
worker that, when privacy mode is on, intercepts every fetch from
controlled clients and returns a synthetic 403 for any cross-origin URL
(same-origin / data: / blob: always pass). It reports each block to the
page over `postMessage` for the live audit log. The page registers the
SW, toggles privacy via `SET_PRIVACY` messages, and the "probe" button
fires a real cross-origin fetch so you can watch it get blocked (privacy
on) or hit the network (privacy off). A `PerformanceObserver` tracks all
resource loads and the cross-origin outbound-byte counter; CSP
violations are also surfaced. Attestation JSON exports the full session.

Remaining: strict-CSP response headers as defence-in-depth; pre-cache
model weights in the SW install step.
