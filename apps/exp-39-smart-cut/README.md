# exp-39-smart-cut · On-Device Smart-Cut (Long-form → Short-form)

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **Opus Clip, Submagic, Riverside Magic Clips**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-39-smart-cut.md`](../../docs/exp-39-smart-cut.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-39-smart-cut dev
```

## Status

v1 scaffold — the pipeline is wired end-to-end with placeholder
implementations of the most expensive component (model inference / WGSL
compute pass / etc.). v2 swaps in the production implementation against
the substrate proven by experiments 01–17.
