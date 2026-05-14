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

v1 scaffold — the pipeline is wired end-to-end with placeholder
implementations of the most expensive component (model inference / WGSL
compute pass / etc.). v2 swaps in the production implementation against
the substrate proven by experiments 01–17.
