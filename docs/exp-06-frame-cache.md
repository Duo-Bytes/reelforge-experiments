# Exp-06 · Frame Cache

## Goal

Implement a 3-tier frame cache inside the render worker so that scrubbing the timeline is instantaneous within ±30 frames of the current playhead position — no decoder round-trip required.

---

## App Location

`apps/exp-06-frame-cache/`

## Why This Matters in the Full NLE

Cold-decoding a GOP on every scrub event takes 100–500ms. Users scrub by dragging — 60 events per second. Without a cache, scrubbing is unusably laggy. With a cache:
- Tier 1 (VRAM): ~200 frames live as `GPUTexture` objects — render in <1ms
- Tier 2 (RAM): ~900 frames as `ImageBitmap` objects — upload to GPU in ~2ms
- Pre-fetcher decodes frames ahead of the playhead while idle

---

## Key APIs

| API | Purpose |
|---|---|
| `device.createTexture({ usage: GPUTextureUsage.TEXTURE_BINDING \| GPUTextureUsage.COPY_DST })` | Allocate a GPU texture for cached frame |
| `device.queue.copyExternalImageToTexture()` | Copy ImageBitmap → GPUTexture |
| `GPUTexture.destroy()` | Free VRAM (call on LRU eviction) |
| `createImageBitmap(videoFrame)` | Copy VideoFrame pixels to RAM as ImageBitmap (allows frame.close()) |
| `ImageBitmap.close()` | Free RAM on Tier 2 eviction |

---

## Cache Design

### Tier 1: VRAM Cache

- Storage: `Map<timestampUs, GPUTexture>` (ordered by timestamp)
- Capacity: 200 frames × 1080p RGBA = 200 × 8MB = ~1.6GB VRAM
  - This is too high for most systems. In practice, use 50–100 frames and tune based on `adapter.limits.maxTextureDimension2D` and available VRAM (no direct API — estimate conservatively)
- Eviction policy: LRU — evict frame farthest from current playhead
- On eviction: call `texture.destroy()`

### Tier 2: RAM Cache

- Storage: `Map<timestampUs, ImageBitmap>`
- Capacity: 200 frames × 1080p RGBA = 200 × 8MB = ~1.6GB RAM
  - Again, tune based on `performance.memory.jsHeapSizeLimit` if available, otherwise 100–200 frames
- Eviction policy: LRU
- On eviction: call `imageBitmap.close()`

### Pre-fetcher

A background `setInterval` (or idle MessageChannel slot) decodes frames ±N frames from the current playhead. N = 30 is a good starting point. The pre-fetcher fills Tier 2 first, then promotes to Tier 1 when the render worker is idle.

---

## Implementation Steps

### 1. Implement the LRU cache

```ts
class LRUCache<K, V> {
  private map = new Map<K, V>()

  constructor(
    private capacity: number,
    private onEvict: (key: K, value: V) => void
  ) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    // Move to end (most recently used)
    const value = this.map.get(key)!
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      const oldestValue = this.map.get(oldest)!
      this.onEvict(oldest, oldestValue)
      this.map.delete(oldest)
    }
  }

  has(key: K): boolean { return this.map.has(key) }
  clear() { this.map.forEach((v, k) => this.onEvict(k, v)); this.map.clear() }
}
```

### 2. Create the frame cache module

```ts
// Inside render.worker.ts

// Tier 1: GPU textures
const vramCache = new LRUCache<number, GPUTexture>(
  VRAM_CAPACITY_FRAMES,
  (ts, texture) => texture.destroy()
)

// Tier 2: ImageBitmaps
const ramCache = new LRUCache<number, ImageBitmap>(
  RAM_CAPACITY_FRAMES,
  (ts, bitmap) => bitmap.close()
)

async function getFrameTexture(timestampUs: number): Promise<GPUTexture> {
  // Tier 1 hit
  const cached = vramCache.get(timestampUs)
  if (cached) return cached

  // Tier 2 hit — upload to GPU
  const bitmap = ramCache.get(timestampUs)
  if (bitmap) {
    const texture = uploadBitmapToGPU(bitmap)
    vramCache.set(timestampUs, texture)
    return texture
  }

  // Cache miss — decode from OPFS
  const frame = await decodeFrameAt(timestampUs)  // from exp-03 pipeline
  const bitmap2 = await createImageBitmap(frame)
  frame.close()  // release GPU texture immediately after creating bitmap

  const texture = uploadBitmapToGPU(bitmap2)
  ramCache.set(timestampUs, bitmap2)
  vramCache.set(timestampUs, texture)
  return texture
}
```

### 3. Upload `ImageBitmap` to GPU texture

```ts
function uploadBitmapToGPU(bitmap: ImageBitmap): GPUTexture {
  const texture = device.createTexture({
    size: [bitmap.width, bitmap.height, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })

  device.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture },
    [bitmap.width, bitmap.height]
  )

  return texture
}
```

Note: This cached texture is a `texture_2d<f32>` in WGSL, NOT a `texture_external`. The WGSL compositor needs two paths:
- Live frames (just decoded, not yet cached): use `texture_external` + `importExternalTexture`
- Cached frames: use `texture_2d<f32>` + standard `textureSample()`

Modify the WGSL fragment shader from exp-04 to accept either type, or have two pipeline variants (live path vs cached path).

### 4. Pre-fetcher

```ts
const PREFETCH_AHEAD = 30
const PREFETCH_BEHIND = 10

let prefetchTimer: ReturnType<typeof setInterval> | null = null

function startPrefetcher(currentTimestampUs: number, fpsInterval: number) {
  if (prefetchTimer) clearInterval(prefetchTimer)

  let prefetchOffset = 1

  prefetchTimer = setInterval(async () => {
    const target = currentTimestampUs + prefetchOffset * fpsInterval
    if (prefetchOffset <= PREFETCH_AHEAD && !ramCache.has(target)) {
      await getFrameTexture(target)  // fills caches as side effect
    }
    prefetchOffset++
    if (prefetchOffset > PREFETCH_AHEAD) {
      clearInterval(prefetchTimer!)
    }
  }, 8)  // 8ms intervals — give render loop priority
}
```

Call `startPrefetcher` whenever the playhead stops moving (after a debounce on SEEK messages).

### 5. Measure and display in UI

Show in the experiment UI:
- Tier 1 size (frames in VRAM)
- Tier 2 size (frames in RAM)
- Last frame render: "VRAM hit / RAM hit / cache miss (Xms)"
- Scrub latency histogram

---

## VRAM and RAM Budget Estimation

There is no direct API to query available VRAM in WebGPU. Use these heuristics:
- Assume 2GB VRAM minimum (modern discrete GPU) → cap Tier 1 at 100 frames × 1080p = 800MB
- Use `performance.memory.jsHeapSizeLimit` (Chrome-only) for RAM budget guidance
- Implement adaptive eviction: if `device.queue.onSubmittedWorkDone()` takes > 16ms, reduce Tier 1 capacity by 10%

---

## Known Pitfalls

**`createImageBitmap(videoFrame)` does a CPU copy.**
This is intentional — we're trading GPU memory for CPU RAM to allow `frame.close()` early. Without this, every cached frame holds a live GPU texture and you can only cache ~50 frames before running out of GPU memory.

**Two WGSL paths needed.**
`texture_external` (for live frames) and `texture_2d<f32>` (for cached frames from GPUTexture) require different WGSL binding types and different sample functions. Keep two pipeline variants or use a preprocessor flag.

**LRU key: use `frame.timestamp` directly.**
Frame timestamps are in microseconds and are unique per video track. Use them as keys without rounding. Rounding to milliseconds risks collisions at high framerates.

**Eviction during scrub.**
If the user scrubs backward rapidly, the cache might evict frames from the pre-fetched forward region. This is fine — the LRU handles it automatically. The pre-fetcher re-fills on next idle.

---

## Success Criteria

| Metric | Target |
|---|---|
| Tier 1 (VRAM) cache hit — render to screen | < 2ms |
| Tier 2 (RAM) cache hit — upload + render | < 5ms |
| Cache miss (cold decode) | < 500ms |
| Scrub ±30 frames around playhead after pre-fetch | 100% Tier 1 hits |
| No GPUTexture leaks after 1000 evictions | Heap stable |
| No ImageBitmap leaks | Heap stable |

---

## Feeds Into

- **Exp-08** audio sync relies on the frame cache for instant frame delivery during playback (the rAF loop must hit Tier 1 on every frame during normal playback)
- **Exp-12** integration wires the pre-fetcher to the timeline playhead position
