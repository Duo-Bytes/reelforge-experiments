# exp-38-plugin-sdk · Plugin / Effect SDK (WGSL Hot-Reload Sandbox)

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **Adobe locks plugin SDKs to native; no browser editor offers one**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-38-plugin-sdk.md`](../../docs/exp-38-plugin-sdk.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-38-plugin-sdk dev
```

## Status

v1 scaffold — the pipeline is wired end-to-end with placeholder
implementations of the most expensive component (model inference / WGSL
compute pass / etc.). v2 swaps in the production implementation against
the substrate proven by experiments 01–17.
