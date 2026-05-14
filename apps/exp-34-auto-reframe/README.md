# exp-34-auto-reframe · Saliency-Driven Auto-Reframe

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **CapCut AutoCut; Riverside Smart Layouts**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-34-auto-reframe.md`](../../docs/exp-34-auto-reframe.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-34-auto-reframe dev
```

## Status

v1 scaffold — the pipeline is wired end-to-end with placeholder
implementations of the most expensive component (model inference / WGSL
compute pass / etc.). v2 swaps in the production implementation against
the substrate proven by experiments 01–17.
