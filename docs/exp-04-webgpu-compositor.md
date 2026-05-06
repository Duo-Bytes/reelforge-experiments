# Exp-04 · WebGPU Compositor

## Goal

Take a `VideoFrame` from exp-03 and render it to a `<canvas>` using WebGPU's `importExternalTexture` (the "zero-copy" path). Then layer two video frames on top of each other with alpha blending to prove multi-layer compositing works without CPU involvement.

---

## App Location

`apps/exp-04-webgpu-compositor/`

## Why This Matters in the Full NLE

Canvas2D `drawImage()` copies VideoFrame pixels from GPU → CPU → GPU on every frame. At 1080p60, that's ~500MB/s of unnecessary memory traffic. WebGPU's `texture_external` binding lets the WGSL shader sample the VideoFrame directly from the hardware decoder's memory — no copy. This is mandatory for multi-track 60fps performance.

---

## Key APIs

| API | Purpose |
|---|---|
| `navigator.gpu.requestAdapter()` | Get GPU adapter |
| `adapter.requestDevice()` | Get GPU device |
| `device.importExternalTexture({ source: frame })` | Zero-copy import of VideoFrame |
| `device.createRenderPipeline(descriptor)` | Compile WGSL vertex + fragment shaders |
| `device.createBindGroup(descriptor)` | Bind textures/samplers to pipeline |
| `encoder.beginRenderPass(descriptor)` | Start render pass |
| `device.queue.submit([commandBuffer])` | Execute GPU commands |
| `navigator.gpu.getPreferredCanvasFormat()` | Canvas pixel format (do NOT hardcode) |

---

## Architecture

```
Main Thread
├── Initialize WebGPU device
├── Configure canvas context
├── For each animation frame (requestAnimationFrame):
│   ├── Get VideoFrame(s) from decode pipeline
│   ├── importExternalTexture for each frame
│   ├── Create bind group(s) with textures
│   ├── Record render pass: draw quad(s)
│   ├── Submit command buffer
│   └── Close VideoFrame(s)  ← AFTER submit, not before
```

This experiment runs on the main thread for simplicity. Exp-05 moves it to a worker.

---

## Implementation Steps

### 1. Initialize WebGPU

```ts
async function initWebGPU(canvas: HTMLCanvasElement) {
  if (!navigator.gpu) throw new Error('WebGPU not supported')

  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('No GPU adapter found')

  const device = await adapter.requestDevice()

  const context = canvas.getContext('webgpu') as GPUCanvasContext
  const format = navigator.gpu.getPreferredCanvasFormat()  // NOT 'bgra8unorm' hardcoded
  context.configure({ device, format })

  return { device, context, format }
}
```

### 2. Write the WGSL shaders

```wgsl
// vertex.wgsl — full-screen quad (no vertex buffer needed)
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // Two triangles covering the full clip space
  var positions = array<vec2f, 6>(
    vec2f(-1.0,  1.0), vec2f(-1.0, -1.0), vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  return vec4f(positions[vi], 0.0, 1.0);
}
```

```wgsl
// fragment.wgsl — sample external texture (zero-copy VideoFrame)
@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture: texture_external;

@fragment
fn fs_main(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  // Compute UV from fragment position
  // In a real compositor, this UV is driven by clip transform uniforms
  let uv = vec2f(fragPos.x / 1920.0, fragPos.y / 1080.0);
  return textureSampleBaseClampToEdge(videoTexture, videoSampler, uv);
}
```

**Critical WGSL note:** `texture_external` is not `texture_2d<f32>`. It requires `textureSampleBaseClampToEdge()` (not `textureSample()`). Using the wrong function causes a shader compile error.

### 3. Create the render pipeline

```ts
function createPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const shaderModule = device.createShaderModule({
    code: COMBINED_WGSL,  // vertex + fragment in one file, separate entry points
  })

  return device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' },
  })
}
```

### 4. Render a VideoFrame (the hot path)

```ts
function renderFrame(
  device: GPUDevice,
  context: GPUCanvasContext,
  pipeline: GPURenderPipeline,
  frame: VideoFrame
) {
  // 1. Import the VideoFrame as an external texture
  const externalTexture = device.importExternalTexture({ source: frame })

  // 2. Create bind group (must be created fresh each frame — externalTexture is ephemeral)
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
      { binding: 1, resource: externalTexture },
    ],
  })

  // 3. Record commands
  const commandEncoder = device.createCommandEncoder()
  const renderPass = commandEncoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear',
      storeOp: 'store',
    }],
  })
  renderPass.setPipeline(pipeline)
  renderPass.setBindGroup(0, bindGroup)
  renderPass.draw(6)  // 6 vertices = 2 triangles = full-screen quad
  renderPass.end()

  // 4. Submit
  device.queue.submit([commandEncoder.finish()])

  // 5. Close the frame AFTER submit (not before — GPU might still be sampling it)
  frame.close()
}
```

### 5. Add a second video layer (alpha blend)

Extend the fragment shader to accept two external textures and blend them:

```wgsl
@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture0: texture_external;  // bottom layer
@group(0) @binding(2) var videoTexture1: texture_external;  // top layer
@group(0) @binding(3) var<uniform> topLayerAlpha: f32;

@fragment
fn fs_main(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let uv = vec2f(fragPos.x / 1920.0, fragPos.y / 1080.0);
  let color0 = textureSampleBaseClampToEdge(videoTexture0, videoSampler, uv);
  let color1 = textureSampleBaseClampToEdge(videoTexture1, videoSampler, uv);
  return mix(color0, color1, topLayerAlpha);
}
```

Use two separate `VideoFrame` objects from exp-03 (two different timestamps of the same clip, or two different clips) and blend them. This proves the compositor can handle multiple simultaneous video layers.

---

## UV Coordinate System for Clip Transforms

In the full editor, each clip on the timeline has a transform (position, scale, rotation). The UV calculation in the fragment shader will be driven by a uniform buffer containing:
```wgsl
struct ClipTransform {
  // 4x4 transform matrix (position, scale, rotation of the quad in clip space)
  matrix: mat4x4f,
  // Source rect in the texture (for crop/trim of the source video)
  srcRect: vec4f,  // (u_min, v_min, u_max, v_max)
  opacity: f32,
}
```
This experiment should hardcode a simple UV mapping. Exp-12 (integration) adds the full transform pipeline.

---

## Known Pitfalls

**`texture_external` is invalidated after the current JS task.**
`importExternalTexture()` returns a texture that is only valid until the end of the current JavaScript task (microtask queue). You MUST call `device.queue.submit()` in the same synchronous block where you created the bind group. If you `await` anything between `importExternalTexture` and `submit`, the texture expires and the GPU reads garbage.

**Wrong canvas format.**
Never hardcode `'bgra8unorm'` as the canvas format. On some systems (especially macOS with Metal), the preferred format is `'rgba8unorm'`. Always use `navigator.gpu.getPreferredCanvasFormat()`.

**Bind group must be recreated every frame.**
`texture_external` cannot be reused across frames. A new `importExternalTexture()` call is required every frame, and a new bind group that references it must be created. This is expected — bind group creation is very cheap compared to rendering.

**YUV → RGB conversion is automatic.**
`texture_external` handles YUV-to-RGB conversion internally. Do NOT attempt to manually convert YUV in the shader — you'll get wrong colors and worse performance.

**`frame.close()` AFTER `submit()`, not before.**
If you close the VideoFrame before submitting the command buffer, the GPU may read from freed memory. Always: encode → submit → close.

**WebGPU requires HTTPS or localhost.**
Ensure the dev server uses localhost (Next.js default). WebGPU is unavailable on HTTP non-localhost origins.

---

## Success Criteria

| Metric | Target |
|---|---|
| Single 1080p frame renders to canvas | Visual quality matches the original frame |
| Frame render time (importExternalTexture → visible on screen) | < 2ms |
| Two-layer alpha blend | Correct visual result |
| No VideoFrame leaks after 1000 frames | Heap stable |
| Main thread CPU during rendering | < 3% (all work on GPU) |

---

## Feeds Into

- **Exp-05** takes this entire render loop and moves it into an `OffscreenCanvas` worker
- **Exp-06** feeds cached frames into this pipeline instead of freshly decoded ones
- **Exp-10** runs this pipeline at export speed (uncapped framerate) into a `VideoEncoder`
- **Exp-11** adds an ONNX-generated mask texture as an additional binding in this compositor
