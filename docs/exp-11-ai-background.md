# Exp-11 · AI Background Removal

## Goal

Run a segmentation model (background removal) entirely client-side using ONNX Runtime Web with the WebGPU execution provider. Apply the resulting mask as a compositing layer in the WebGPU WGSL shader — no server call, no data upload, user's video stays local.

---

## App Location

`apps/exp-11-ai-background/`

## Why This Matters in the Full NLE

Background removal is a high-value editing feature. Cloud-based implementation = privacy risk + API cost + latency. Running inference on the user's local GPU via ONNX WebGPU:
- Zero data leaves the device
- Inference time: target < 100ms per frame
- No per-use cost
- Works offline

---

## Model Selection

Use **RMBG-1.4** by BriaAI: a dedicated background matting model in ONNX format (~176MB). It produces a soft alpha matte (not a binary mask), giving better edge quality than simple segmentation.

Alternative (faster, smaller): **MediaPipe Selfie Segmentation** (~2.5MB, but lower quality edges).

For this experiment, implement RMBG-1.4 first. If inference > 100ms, also implement MediaPipe and compare.

Model download: fetch from HuggingFace Hub and cache with `Cache API` to avoid re-download on every page load.

---

## Key APIs & Libraries

| Tool | Purpose |
|---|---|
| `onnxruntime-web` v1.19+ | Run ONNX model in browser |
| WebGPU execution provider (EP) | Run inference on GPU — same device as compositor |
| `Cache API` (`caches.open()`) | Store downloaded model to avoid re-fetching |
| `createImageBitmap(videoFrame)` | Convert VideoFrame → ImageBitmap for pre-processing |

---

## Architecture

```
AIWorker (dedicated worker)
│
├── On startup: load ONNX model (from Cache API or fetch)
├── Creates InferenceSession with WebGPU EP
│
├── Receives: { type: 'SEGMENT', frame: VideoFrame, timestampUs: number }
├── Pre-process: VideoFrame → 1024×1024 RGB float tensor
├── Run inference: session.run(input) → alpha mask tensor
├── Post-process: mask tensor → Uint8Array (grayscale PNG-compatible)
├── Upload mask to GPU as GPUTexture
└── Sends: { type: 'MASK_READY', timestampUs, maskTexture }
    (maskTexture transferred to RenderWorker)
```

---

## Implementation Steps

### 1. Install ONNX Runtime Web

```bash
npm install onnxruntime-web
```

ONNX Runtime Web requires WASM and WebGPU binaries. In Next.js, configure the ONNX WASM path:

```ts
// src/app/layout.tsx or a global setup file
import * as ort from 'onnxruntime-web'

// Tell ort where to find its WASM files (served from public/)
ort.env.wasm.wasmPaths = '/onnx/'

// Copy from node_modules/onnxruntime-web/dist/ to public/onnx/ in next.config.ts:
// Use the `copy-webpack-plugin` or just manually copy the 4 .wasm files
```

In `next.config.ts`, add:
```ts
import CopyPlugin from 'copy-webpack-plugin'
// In webpack config:
new CopyPlugin({
  patterns: [{
    from: 'node_modules/onnxruntime-web/dist/*.wasm',
    to: 'static/chunks/[name][ext]',
  }],
})
```

Or simply copy the `.wasm` files to `public/onnx/` as a build step.

### 2. Load and cache the ONNX model

```ts
const MODEL_URL = 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx'
const CACHE_NAME = 'reelforge-models-v1'

async function loadModel(): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(MODEL_URL)

  if (cached) {
    console.log('Model loaded from Cache API')
    return cached.arrayBuffer()
  }

  console.log('Downloading model (~176MB)...')
  const response = await fetch(MODEL_URL)
  await cache.put(MODEL_URL, response.clone())
  return response.arrayBuffer()
}

async function createSession(): Promise<ort.InferenceSession> {
  const modelBuffer = await loadModel()
  return ort.InferenceSession.create(modelBuffer, {
    executionProviders: ['webgpu'],  // falls back to 'wasm' if WebGPU EP unavailable
    graphOptimizationLevel: 'all',
  })
}
```

### 3. Pre-process a VideoFrame into an ONNX tensor

RMBG-1.4 expects: `float32 tensor, shape [1, 3, 1024, 1024], NCHW, values normalized to [0, 1]`

```ts
async function videoFrameToTensor(frame: VideoFrame): Promise<ort.Tensor> {
  // Step 1: Draw to a 1024×1024 canvas
  const canvas = new OffscreenCanvas(1024, 1024)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(frame, 0, 0, 1024, 1024)

  // Step 2: Read RGBA pixels
  const imageData = ctx.getImageData(0, 0, 1024, 1024)
  const rgba = imageData.data  // Uint8ClampedArray, length = 1024*1024*4

  // Step 3: Convert RGBA → NCHW float32 [1, 3, 1024, 1024]
  const numPixels = 1024 * 1024
  const tensor = new Float32Array(3 * numPixels)

  for (let i = 0; i < numPixels; i++) {
    tensor[i]                  = rgba[i * 4 + 0] / 255  // R channel
    tensor[numPixels + i]      = rgba[i * 4 + 1] / 255  // G channel
    tensor[2 * numPixels + i]  = rgba[i * 4 + 2] / 255  // B channel
    // Alpha channel ignored
  }

  return new ort.Tensor('float32', tensor, [1, 3, 1024, 1024])
}
```

### 4. Run inference

```ts
async function segmentFrame(session: ort.InferenceSession, frame: VideoFrame): Promise<Float32Array> {
  const inputTensor = await videoFrameToTensor(frame)

  // Input name: check model's input node name
  // For RMBG-1.4, input is typically 'input'
  const feeds = { input: inputTensor }

  const results = await session.run(feeds)

  // Output: sigmoid logits, shape [1, 1, 1024, 1024]
  const outputTensor = results[Object.keys(results)[0]]
  const maskData = outputTensor.data as Float32Array
  // Values are [0, 1] — 1 = foreground, 0 = background

  return maskData
}
```

### 5. Upload mask to GPU as GPUTexture

```ts
function maskToGPUTexture(device: GPUDevice, maskData: Float32Array): GPUTexture {
  // Convert Float32 mask to RGBA Uint8 for GPU upload
  // R channel = mask value, G/B/A unused (or use as alpha directly)
  const rgba = new Uint8Array(1024 * 1024 * 4)
  for (let i = 0; i < 1024 * 1024; i++) {
    const v = Math.round(maskData[i] * 255)
    rgba[i * 4 + 0] = v  // R = mask
    rgba[i * 4 + 1] = 0
    rgba[i * 4 + 2] = 0
    rgba[i * 4 + 3] = 255
  }

  const texture = device.createTexture({
    size: [1024, 1024, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture(
    { texture },
    rgba,
    { bytesPerRow: 1024 * 4 },
    [1024, 1024]
  )
  return texture
}
```

### 6. Apply mask in WGSL compositor

Modify the compositor's fragment shader (from exp-04) to accept the mask texture and apply it:

```wgsl
@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture: texture_external;
@group(0) @binding(2) var maskTexture: texture_2d<f32>;   // mask from ONNX

@fragment
fn fs_main(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let uv = vec2f(fragPos.x / 1920.0, fragPos.y / 1080.0);

  let videoColor = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv);
  let maskValue  = textureSample(maskTexture, videoSampler, uv).r;

  // Soft alpha: keep foreground (maskValue = 1), remove background (maskValue = 0)
  return vec4f(videoColor.rgb, maskValue);
}
```

This outputs a video frame with the background removed. Compositing this on top of another video layer or a solid color gives the final background-replaced result.

---

## Performance Optimization

**Run inference only on keyframes.**
Segmentation is expensive (~50–100ms). For smooth playback, compute the mask on every N-th frame (e.g., every 15 frames = every 0.5s at 30fps) and interpolate the mask between keyframes. Mask interpolation: linear blend of adjacent float32 mask arrays.

**WebGPU EP vs WASM EP.**
WebGPU execution provider runs inference on the GPU. WASM EP runs on CPU. For RMBG-1.4 (176MB), WebGPU EP is typically 3–10× faster. If WebGPU EP fails to initialize (check `ort.env.webgpu.isAvailable`), fall back to WASM EP.

**Model quantization.**
RMBG-1.4 has a quantized INT8 version (~44MB). Inference quality is nearly identical but download size is 4× smaller and inference speed is faster on hardware with INT8 support. Try both.

---

## Known Pitfalls

**ONNX WebGPU EP requires cross-origin isolation.**
The same COOP/COEP headers required by SharedArrayBuffer are also required for the ONNX WebGPU EP to initialize. Without them, it silently falls back to WASM.

**`willReadFrequently: true` for the pre-processing canvas.**
`getImageData()` on a canvas that wasn't created with `willReadFrequently` is extremely slow (triggers GPU → CPU readback). Always pass `{ willReadFrequently: true }` to `getContext('2d', ...)` for canvases you'll call `getImageData()` on.

**Model input name.**
The ONNX model's input tensor name varies by model. Check via:
```ts
console.log(session.inputNames)   // ['input'] or ['images'] or similar
console.log(session.outputNames)  // ['output'] or ['masks']
```
Use the actual names from the session — don't assume.

**HuggingFace CDN CORS.**
Fetching from HuggingFace Hub may require CORS headers. Check if the URL supports `Access-Control-Allow-Origin: *`. If not, host the ONNX file yourself (e.g., in `/public/models/`). For the experiment, download the file once and put it in `public/models/rmbg-1.4.onnx` to avoid CDN issues.

**Cache API storage.**
`Cache API` storage quota is typically shared with other storage (IndexedDB, OPFS). A 176MB model caching successfully depends on available quota. Check with `navigator.storage.estimate()` and warn the user if insufficient.

**ort.Tensor data ownership.**
After `session.run()`, the returned tensors own their buffers. Read the data synchronously before awaiting anything, or the buffer may be GC'd. Copy to a new `Float32Array` immediately:
```ts
const maskCopy = new Float32Array(results.output.data as Float32Array)
```

---

## Success Criteria

| Metric | Target |
|---|---|
| Model loads from Cache API (2nd+ visit) | < 2 seconds |
| Inference time per frame (RMBG-1.4, WebGPU EP) | < 100ms |
| Background removed visually clean (hair, edges) | Subjective: good quality |
| Mask applied in WebGPU compositor | No artifact at layer edges |
| No memory leak (model session stays open) | Heap stable after 100 inferences |
| Works offline after first model download | Verified by toggling network off |

---

## Feeds Into

- **Exp-12** adds a "Background Removal" toggle to the clip properties panel. When enabled, exp-11's AIWorker is invoked per keyframe and the mask is passed to the render worker.
