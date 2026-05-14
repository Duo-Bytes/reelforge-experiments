# Exp-35 · WebGPU Compute Scopes — Waveform / Vectorscope / Parade / Histogram

## Goal

Generate DaVinci-grade video scopes (luma waveform monitor, RGB parade,
vectorscope, histogram) from the live preview `GPUTexture` via WGSL
compute passes, displayed in side `OffscreenCanvas`es. All four scopes
update at preview framerate without dropping the compositor.

## App Location

`apps/exp-35-scopes/`

## Why This Matters — Competitive Edge

No browser editor ships real scopes in 2026. fylm.ai and Fresh LUTs
offer LUT preview only. DaVinci Resolve is desktop-only. Adding scopes
unlocks the "browser DaVinci" positioning and pairs naturally with the
HDR/color pipeline (exp-13) and 3D LUTs (exp-20).

See [`research-competitive-edge.md`](./research-competitive-edge.md) §35.

## Key APIs

| API | Where used |
|---|---|
| `GPUComputePipeline` + WGSL `@compute @workgroup_size` | Bin accumulation |
| `texture_storage_2d<r32uint, read_write>` + atomics | f32→uint quantized histogram |
| `bitmaprenderer` canvas context | Zero-copy mirror to scope canvases |
| `GPUDevice.queue.writeTexture` / `copyTextureToBuffer` | Result readback |
| `GPUCanvasContext.configure({ colorSpace })` | Color-space-aware scopes |

## Scope kinds

| Scope | Output | Use |
|---|---|---|
| **Luma Waveform** | x = source column, y = luma 0..1, brightness = count | Exposure + clipping |
| **RGB Parade** | 3 waveforms side-by-side, one per channel | White balance + per-channel clip |
| **Vectorscope** | UV plane plot, color cast vs target hue | Skin tone, gamut |
| **Histogram** | 256-bin per channel | Tonal distribution |

## WGSL outline

```wgsl
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bins: array<atomic<u32>>;

@compute @workgroup_size(8, 8)
fn waveform(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(src);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let rgb = textureLoad(src, vec2<i32>(gid.xy), 0).rgb;
  let y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  let bin = u32(clamp(y, 0.0, 1.0) * 255.0);
  let idx = gid.x * 256u + bin; // 1 column × 256 bins
  atomicAdd(&bins[idx], 1u);
}
```

Read bins back via `copyBufferToBuffer` → `mapAsync`, draw to scope
canvas via 2D context (fast) or another fragment pass (faster, but
buffer-coordinate aware).

## Success Criteria

1. All four scopes update every frame at 1080p60 with the compositor
   maintaining 60 fps preview.
2. Histogram-sum-of-bins equals pixel count exactly (no atomic loss).
3. Color-space-correct: BT.709 footage produces a vectorscope cluster
   inside the BT.709 100 % saturation box; Display-P3 footage shows
   measurable extension toward the P3 gamut boundary.
4. Reading scopes adds < 1 ms to the compositor's per-frame budget
   (measured via `requestAnimationFrame` deltas).
5. Heap snapshot stable over 10 minutes of continuous scrub + scope
   render.

## Foot-guns

- WebGPU has no atomic f32 add. Use `r32uint` bins; pre-quantize values
  to integers; convert on read.
- `texture_storage_2d` write requires the `bgra8unorm-storage` feature
  on macOS Metal — feature-detect and fall back to a two-pass write
  path.
- Atomic contention at the binning stage is brutal when many pixels
  share a bin (e.g. solid blue sky). Mitigate with per-workgroup shared
  bins followed by an atomic merge.
- Buffer readback latency is one-frame; either accept the lag or render
  the scopes from a two-pass compute that writes to a sampled texture
  the canvas fragment shader reads directly.
- Vectorscope quadrants are *not* RGB but YUV (Cb, Cr); convert
  carefully or your skin-tone line will be 60° off.

## Demo

- Compositor preview canvas on the left.
- 2×2 grid of scope canvases on the right (Luma WFM, RGB Parade,
  Vectorscope, Histogram).
- Scrub the timeline (exp-09); scopes track every frame.
- Apply an LUT (exp-20); scopes reflect the change immediately.
