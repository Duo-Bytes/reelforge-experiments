# exp-11 · AI Background Removal

## Purpose

Run a segmentation model **entirely client-side** with `onnxruntime-web` on the **WebGPU execution provider**, and feed the resulting alpha matte into the WebGPU compositor as a `texture_2d<f32>` binding. Soft alpha at the layer's edges, no network round-trip per frame, no data leaves the device.

## Architecture

```
Main Thread (page.tsx)
├── Worker(ai.worker.ts) lifecycle
├── Model load:
│     LOAD_URL  -> caches.match / caches.put (Cache API persistence)
│     LOAD_BYTES -> bypass (file upload)
├── Image input -> createImageBitmap(file)
├── On RUN -> postMessage({SEGMENT, bitmap, inputSize: 1024, inputName})
│             [transfer bitmap]
├── On {MASK, mask: Uint8Array, w, h, inferenceMs}:
│     ensureGPU() -> WebGPU device, pipeline, sampler, uniform buffer
│     Build srcTex from imageBitmap (copyExternalImageToTexture)
│     Build maskTex from Uint8Array (writeTexture, R-channel only)
│     Uniforms: bgColor, useMask, showMaskOnly
│     Render quad (draw 6) -> submit
│     Tear down transient textures (.destroy())
└── Show inference history (median across last 20 runs)

ai.worker.ts (onnxruntime-web/webgpu)
├── ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/"
│   (Turbopack does not copy WASM out of node_modules; CDN avoids that.)
├── createSession(modelBytes):
│     try executionProviders: ["webgpu", "wasm"]
│     fall back to ["wasm"] on failure (still functional, just slower)
├── On SEGMENT:
│     OffscreenCanvas(1024,1024) ctx.getImageData() with willReadFrequently:true
│     RGBA -> NCHW Float32, normalize /255 (RMBG-1.4 input contract)
│     ort.Tensor("float32", ..., [1,3,1024,1024])
│     session.run({ [inputName]: tensor })
│     Output sigmoid -> Uint8Array * 255 (transferable)
│     dispose tensors, close bitmap
└── post {MASK, mask, w, h, inferenceMs, totalMs} with [mask.buffer] transfer

src/shaders/mask.wgsl.ts
├── texture_2d<f32> source (NOT external — we render still images here)
├── texture_2d<f32> mask (R = alpha)
├── uniform { bgColor: vec4f, flags: vec4f }   # flags.x=useMask, flags.y=showMaskOnly
└── fragment: showMaskOnly -> grayscale of mask;
              useMask -> mix(bgColor, srcColor, mask.r);
              else -> srcColor passthrough
```

## Research notes

- **`onnxruntime-web/webgpu`** is the WebGPU EP entry point in ORT 1.23+. The plain `onnxruntime-web` import is the WASM EP. Choosing the right import is half the perf battle. (Doc was written for 1.19; we're on 1.23, the import path moved.)
- **Cross-origin isolation is mandatory** for the WebGPU EP. The COOP/COEP headers in `next.config.ts` provide it; without them ORT silently falls back to WASM and inference is 3–10× slower.
- **`ort.env.wasm.wasmPaths` must point somewhere**. ORT loads its own `.wasm`/`.mjs` shims at runtime. Turbopack 16 has no `CopyWebpackPlugin` equivalent so the cleanest path is a CDN like jsDelivr. For an air-gapped build we'd vendor the files into `public/onnx/` and set `wasmPaths` to `/onnx/`.
- **Cache API persistence.** First load fetches ~176MB; subsequent visits hit `caches.match()` and skip the network. Use a versioned cache name (`reelforge-models-v1`) so we can bust on model upgrades.
- **`willReadFrequently: true`** on the pre-process canvas is non-negotiable — `getImageData()` on a non-readback canvas triggers a GPU→CPU readback per call (~20ms at 1024×1024) on top of inference time.
- **Input names vary by model.** RMBG-1.4 uses `"input"`, MediaPipe Selfie uses `"input_1"`. We dynamically read `session.inputNames[0]` and surface it in the UI so retraining the model doesn't require code changes.
- **NCHW float32 normalization to [0,1]** matches RMBG-1.4's training. SAM-style models want ImageNet-normalized inputs; if you swap models, also swap the normalization.
- **Output is `[1,1,H,W]`** sigmoid — values already in `[0,1]`. We multiply by 255 and clamp into `Uint8Array` for compact transfer to main thread.
- **Tensor disposal.** `tensor.dispose()` (when present) frees the underlying buffer immediately. Otherwise the buffer is GC'd, which can stall the next inference for ~30ms while WebGPU resources are reclaimed.
- **Transient GPU textures** are destroyed after each render (`srcTex.destroy(); maskTex.destroy()`). For animated re-renders we'd cache them; for one-shot segment+show this is fine.
- **WGSL: `texture_2d<f32>` not `texture_external`** for both the image source (since it's an `ImageBitmap`-derived texture, not a live `VideoFrame`) and the mask. `textureSample()` is the correct intrinsic — `textureSampleBaseClampToEdge` is exclusive to external textures.
- **HuggingFace CDN CORS** is permissive for the `resolve/main/...` URL but rate-limited. For a production app we'd self-host the ONNX or use a paid CDN. Local file upload is the offline fallback.
- **WebGPU EP fallback to WASM** on machines without WebGPU support (older iOS, software-rendered Linux). Still functional, just slower (~300–500ms vs ~50–100ms). The UI shows which provider is active.

## Files

| File | Purpose |
|---|---|
| `src/shaders/mask.wgsl.ts` | WGSL: source × mask × bgColor compositor |
| `src/workers/ai.worker.ts` | onnxruntime-web/webgpu session + Cache-API model fetch |
| `src/app/page.tsx` | model URL/file inputs, image picker, segmentation trigger, mask compositor |
| `next.config.ts` | COOP/COEP headers (required for WebGPU EP) |

## Run

```bash
pnpm --filter exp-11-ai-background dev
```

Recommended models:
- **RMBG-1.4** (BriaAI) — `https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx` (176MB)
- For offline: download once, upload via the local-file picker.

## Success criteria

| Metric | Target |
|---|---|
| Model load (Cache API hit) | < 2s |
| Inference per 1024×1024 image (WebGPU EP) | < 100ms |
| Background-removed edges (hair / fine detail) | clean (subjective) |
| Provider badge shows `webgpu` | yes (with COOP/COEP active) |
| 100 inferences in a row | heap stable, no leaks |
