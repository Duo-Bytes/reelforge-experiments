# exp-33-voice-isolate · On-Device Voice Isolation / Denoise

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **Descript Studio Sound; Adobe Enhance Speech**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-33-voice-isolate.md`](../../docs/exp-33-voice-isolate.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-33-voice-isolate dev
```

## Status

v1 scaffold — the pipeline is wired end-to-end with placeholder
implementations of the most expensive component (model inference / WGSL
compute pass / etc.). v2 swaps in the production implementation against
the substrate proven by experiments 01–17.
