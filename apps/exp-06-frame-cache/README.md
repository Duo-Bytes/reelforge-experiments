# exp-06 · Frame Cache

## Purpose

Make scrubbing **instantaneous** within ±30 frames of the playhead. Cold-decoding a GOP per scrub event takes 100–500ms; users drag at 60Hz. Solution: a 3-tier cache inside the render worker, plus a pre-fetcher that fills the surrounding window while the user is idle.

## Architecture

```
Tier 1: VRAM        Map<ptsUs, GPUTexture>     LRU 60 frames (~470MB @1080p)
Tier 2: RAM         Map<ptsUs, ImageBitmap>    LRU 200 frames
Tier 3: cold decode VideoDecoder via decode.worker.ts (slowest)

Main Thread (page.tsx)
├── transferControlToOffscreen -> render.worker.ts
├── seek slider / preset buttons -> {SEEK} + {PREFETCH}
├── bench button -> 60 random ±30-frame scrubs after seeding cache
└── displays tier hits, fetch/draw/total ms

render.worker.ts
├── INIT: WebGPU device, pipeline (single texture_2d<f32> path), sampler
├── LOAD: spawn decode sub-worker, clear caches
├── SEEK(targetUs):
│   ├── getTexture(targetUs):
│   │     1) vramCache.get -> tier "vram"
│   │     2) ramCache.get -> uploadToVRAM (copyExternalImageToTexture) -> tier "ram"
│   │     3) decodeBitmap(targetUs) -> uploadToVRAM -> tier "miss"
│   ├── fresh bindGroup (pipeline.getBindGroupLayout(0))
│   ├── encoder.beginRenderPass + draw(6) + submit
│   └── post {RENDERED, tier, fetchMs, drawMs, totalMs, sizes}
├── PREFETCH(centerUs): setInterval(8ms) schedules ±30 frames out from center,
│                       skips already-cached and pending
├── decodeBitmap coalesces duplicate pending requests by ptsUs (resolvers[])
└── On FRAME from decoder: createImageBitmap(frame) -> frame.close() (GPU mem)
                           -> ramCache.set(ts, bitmap) -> resolve all waiters

LRUCache<K,V> (src/lib/lru.ts)
└── Map insertion-order LRU; onEvict = (k,v) => texture.destroy() | bitmap.close()
```

## Research notes

- **`createImageBitmap(videoFrame)` is a CPU copy.** Intentional — trades GPU memory for RAM so we can `frame.close()` early. Without it, every cached frame pins a hardware decoder texture and the cache fills up after ~20 frames.
- **`copyExternalImageToTexture` is the upload path** from `ImageBitmap`/`HTMLImageElement` to a `GPUTexture`. Single GPU command, ~1–2ms at 1080p.
- **Two WGSL pipelines required for the full editor.** Live frames (just decoded, not yet cached) use `texture_external` + `textureSampleBaseClampToEdge`. Cached frames use `texture_2d<f32>` + plain `textureSample`. This experiment stays in the cached path; exp-12 will need both pipelines side-by-side.
- **GPUTexture must be `.destroy()`d on eviction.** Otherwise VRAM leaks until the device is destroyed. ImageBitmap must be `.close()`d. Both handled by the LRU's `onEvict` callback.
- **Cache key = exact PTS in microseconds.** Frame timestamps are unique per video track. Don't round to ms — collisions at high framerates would corrupt the cache.
- **Pending-request coalescing.** Two near-simultaneous SEEKs to the same PTS (slider-drag + auto-prefetch) must produce one decoder request. We use a `Map<pts, {resolvers[], rejectors[]}>` and dispatch all waiters when the frame lands.
- **VRAM budget heuristic.** No portable API to query VRAM. Default 60 × 8MB ≈ 480MB which is conservative for a discrete GPU. Configurable in the UI.
- **Pre-fetcher on `setInterval(8ms)`** rather than a tight loop so the render path stays priority. 2 frames scheduled per tick alternating ahead/behind, capped at PREFETCH_AHEAD=30 / PREFETCH_BEHIND=10.

## Files

| File | Purpose |
|---|---|
| `src/lib/lru.ts` | Generic LRUCache with `onEvict` callback |
| `src/shaders/cached.wgsl.ts` | Cached-path WGSL (`texture_2d<f32>` + `textureSample`) |
| `src/workers/render.worker.ts` | OffscreenCanvas + 3-tier cache + pre-fetcher |
| `src/workers/decode.worker.ts` | Inherited from exp-03 |
| `src/lib/types.ts` | Shared types from exp-02 |
| `src/app/page.tsx` | Cache config inputs, seek slider, scrub bench |

## Run

```bash
pnpm --filter exp-06-frame-cache dev
```

## Success criteria

| Metric | Target |
|---|---|
| VRAM hit (Tier 1) total render | < 2ms |
| RAM hit (Tier 2) upload + render | < 5ms |
| Cold miss | < 500ms |
| ±30-frame scrub bench | 100% Tier 1 hits after pre-fetch settles |
| 1000 evictions, no GPUTexture / ImageBitmap leaks | heap stable |
