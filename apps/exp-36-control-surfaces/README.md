# exp-36-control-surfaces · Hardware Control Surfaces (WebMIDI + WebHID)

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **Cloud editors cannot — no native install path**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-36-control-surfaces.md`](../../docs/exp-36-control-surfaces.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-36-control-surfaces dev
```

## Status

v2 — real hardware I/O. `src/lib/controls.ts` binds WebMIDI
(`navigator.requestMIDIAccess`) input ports and WebHID
(`navigator.hid.requestDevice`) input reports, forwarding raw payloads to
the UI. Includes working decoders for the Behringer X-Touch Mini (CC,
both relative and MC modes) and the Contour ShuttlePro v2 (jog / shuttle
/ button bitmap). New devices slot in as thin per-device parser
functions.

Remaining: persist device IDs in IndexedDB and re-bind via
`navigator.hid.getDevices()` on reload; map controls onto the exp-04
lift/gamma/gain + exp-09 transport.
