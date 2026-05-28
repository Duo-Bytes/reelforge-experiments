# exp-35-scopes · WebGPU Compute Scopes

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **DaVinci-grade scopes (desktop only); no browser editor ships these**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-35-scopes.md`](../../docs/exp-35-scopes.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-35-scopes dev
```

## Status

v2 — real WGSL compute. `src/lib/scopes.ts` uploads the source frame to
a GPUTexture and runs a single compute pass that accumulates luma
waveform, RGB parade, vectorscope, and histogram into `atomic<u32>`
storage bins, read back each frame into `ScopeReadback`. To go fully
zero-copy, swap the `writeTexture` upload for the exp-04 compositor's
output texture.

Remaining: per-workgroup shared bins → atomic merge to reduce global
contention; color-space-aware vectorscope per exp-13.
