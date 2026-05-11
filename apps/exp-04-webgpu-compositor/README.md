# exp-04 · WebGPU Compositor

## Purpose

Render a `VideoFrame` to a canvas via WebGPU's **zero-copy** path: import the frame as `texture_external`, sample it in WGSL, draw a full-screen quad. Then layer two video frames with alpha blending to prove multi-track compositing works without CPU involvement. `Canvas2D.drawImage(VideoFrame)` does a GPU→CPU→GPU round-trip; at 1080p60 that's ~500MB/s of pointless bus traffic.

## Architecture

```
Main Thread (page.tsx)
├── decode.worker.ts (same as exp-03) ── frames for "bottom" + "top" slot
├── canvasRef -> getContext("webgpu")
├── on FRAME: route to bottom/top slot based on pendingRef map
└── renderComposite(ctx, bottom, top|null, alpha)

src/lib/compositor.ts
├── initCompositor(canvas):
│   ├── adapter = navigator.gpu.requestAdapter()
│   ├── device = adapter.requestDevice()
│   ├── format = navigator.gpu.getPreferredCanvasFormat()  # NOT hardcoded
│   ├── context.configure({device, format, alphaMode: "premultiplied"})
│   ├── shader module from COMPOSITE_WGSL (single file, vs_main + fs_main)
│   ├── pipeline (layout: "auto", primitive: "triangle-list")
│   ├── linear sampler
│   └── 16-byte uniform buffer (topAlpha, useTop, _pad, _pad)
└── renderComposite(ctx, bottom, top, alpha):  # SYNCHRONOUS — no awaits!
    ├── queue.writeBuffer(uniformBuffer, ...)
    ├── importExternalTexture({source: bottom})
    ├── importExternalTexture({source: top}) OR alias to bottom for single-layer
    ├── createBindGroup(...)  # fresh every frame — externals expire end-of-task
    ├── encoder = createCommandEncoder()
    ├── pass.setPipeline; setBindGroup; draw(6)  # 6 verts = 2 tris = full-screen quad
    └── queue.submit([encoder.finish()])

src/shaders/composite.wgsl.ts (template literal, exported as COMPOSITE_WGSL)
├── @vertex   vs_main: 6 hardcoded clip-space positions, 6 UVs
└── @fragment fs_main: textureSampleBaseClampToEdge(tex0/1, sampler, uv) -> mix(by topAlpha)
```

## Research notes

- **`texture_external` invalidates at the end of the current JS task.** `importExternalTexture` returns a binding that is only valid until the microtask queue drains. You must call `queue.submit()` in the same synchronous block. **Awaiting between import and submit = GPU reads garbage.**
- **Bind group must be recreated every frame.** External textures cannot be reused across frames. Bind group creation is cheap; rendering is the cost.
- **WGSL: `textureSampleBaseClampToEdge`, NOT `textureSample`.** External textures use a dedicated sampling intrinsic. Using `textureSample` on a `texture_external` is a shader compile error.
- **YUV→RGB is automatic.** `texture_external` handles YUV conversion internally. Don't write your own — wrong colors and worse perf.
- **Always `getPreferredCanvasFormat()`.** macOS/Metal often prefers `rgba8unorm`, not `bgra8unorm`. Hardcoding breaks portability.
- **Close VideoFrame AFTER submit.** Submit is async on the GPU side, but Chrome's WebGPU impl refs/copies internally on submit, so closing immediately after is safe in practice.
- **Single-layer case still needs two texture bindings.** WGSL won't tolerate an "unused" `texture_external` binding being unbound. We alias the bottom frame to both slots when `useTop=false`.
- **`alphaMode: "premultiplied"`** on the canvas context matches our WGSL output (which assumes premultiplied alpha when blending external textures).

## Files

| File | Purpose |
|---|---|
| `src/shaders/composite.wgsl.ts` | WGSL exported as a TS template literal |
| `src/lib/compositor.ts` | `initCompositor` + `renderComposite` |
| `src/lib/types.ts` | Shared types from exp-02 |
| `src/workers/decode.worker.ts` | Inherited from exp-03 |
| `src/app/page.tsx` | Two-slider layer UI, alpha slider, 1000-render stress |

## Run

```bash
pnpm --filter exp-04-webgpu-compositor dev
```

WebGPU requires Chrome 113+ and a non-software GPU. Run on `localhost` or HTTPS.

## Success criteria

| Metric | Target |
|---|---|
| Single-frame render | < 2ms |
| Two-layer alpha blend | visually correct |
| 1000 renders, no leaks | heap stable |
| Main-thread CPU during render loop | < 3% (all on GPU) |
