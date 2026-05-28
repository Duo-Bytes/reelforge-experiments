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

v2 — real WGSL compilation in a sandbox worker. `src/workers/plugin.worker.ts`
owns a WebGPU device + transferred OffscreenCanvas, compiles plugin WGSL
via `createShaderModule`, and surfaces real `getCompilationInfo()`
diagnostics plus validation-scope errors without crashing the UI. The
fragment is linked with a host full-screen-triangle vertex stage and
rendered over a generated base texture; params pack into a std140
uniform buffer (`packParams`) and update the live preview with no
recompile. Edit the JSON and click out to hot-reload.

Remaining: deny `fetch`/storage on the worker scope via the exp-37
service worker; `FileSystemObserver` hot-reload from a local directory;
budget kill-switch via `device.destroy()`.
