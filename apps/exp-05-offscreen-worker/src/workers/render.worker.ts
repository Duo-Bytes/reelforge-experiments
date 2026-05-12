/// <reference lib="webworker" />

// Procedurally animates a pattern entirely inside a worker-owned OffscreenCanvas
// using WebGPU. No frame source from the main thread is needed — the point of
// this experiment is to prove that React/main-thread work cannot stutter the
// render loop. exp-06 + exp-12 add a real decode pipeline.

type Init = { type: 'INIT'; canvas: OffscreenCanvas; width: number; height: number }
type Play = { type: 'PLAY' }
type Pause = { type: 'PAUSE' }
type Resize = { type: 'RESIZE'; width: number; height: number }
type InMsg = Init | Play | Pause | Resize

const WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2f, 6>(
    vec2f(-1.0,  1.0), vec2f(-1.0, -1.0), vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  var out: VSOut;
  out.position = vec4f(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}

struct U {
  time: f32,
  width: f32,
  height: f32,
  frame: f32,
}

@group(0) @binding(0) var<uniform> u: U;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let aspect = u.width / u.height;
  let p = (in.uv * 2.0 - 1.0) * vec2f(aspect, 1.0);
  // gradient background
  let bg = vec3f(0.15 + 0.5 * sin(u.time * 0.7),
                 0.20 + 0.5 * sin(u.time * 0.9 + 1.0),
                 0.55 + 0.4 * sin(u.time * 0.5 + 2.0));
  // an orbiting disc to show motion
  let cx = cos(u.time) * 0.5 * aspect;
  let cy = sin(u.time * 1.3) * 0.5;
  let d = distance(p, vec2f(cx, cy));
  let disc = smoothstep(0.18, 0.16, d);
  let color = mix(bg, vec3f(1.0), disc);
  // bottom bar that advances with the frame counter, useful for visual stutter detection
  let barY = -0.95;
  let isBar = step(in.uv.y, 0.02);
  let barProgress = fract(u.frame / 240.0); // ~4 s @ 60 fps
  let isFilled = step(in.uv.x, barProgress);
  let final = mix(color, vec3f(1.0, 1.0, 0.2), isBar * isFilled);
  return vec4f(final, 1.0);
}
`

let device: GPUDevice | null = null
let context: GPUCanvasContext | null = null
let pipeline: GPURenderPipeline | null = null
let uniformBuf: GPUBuffer | null = null
let bindGroup: GPUBindGroup | null = null
let canvasW = 1280
let canvasH = 720
let isPlaying = false
let frameCount = 0
let lastReportT = 0
let framesSinceReport = 0
const t0 = performance.now()

const { port1, port2 } = new MessageChannel()
port2.onmessage = () => {
  if (isPlaying) renderOne()
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data
  if (m.type === 'INIT') {
    await initGpu(m.canvas, m.width, m.height)
    return
  }
  if (m.type === 'PLAY') {
    if (!isPlaying) {
      isPlaying = true
      port1.postMessage(null)
    }
    return
  }
  if (m.type === 'PAUSE') {
    isPlaying = false
    return
  }
  if (m.type === 'RESIZE') {
    canvasW = m.width
    canvasH = m.height
    if (context && device) {
      // The OffscreenCanvas's width/height must be set; that's how the context resizes.
      // The canvas is owned by us via INIT, so adjust here.
      // Note: we keep a handle to the OffscreenCanvas via the context.canvas property.
      const oc = (context.canvas as unknown as OffscreenCanvas)
      oc.width = m.width
      oc.height = m.height
    }
    return
  }
}

async function initGpu(canvas: OffscreenCanvas, width: number, height: number) {
  canvasW = width
  canvasH = height
  canvas.width = width
  canvas.height = height
  if (!('gpu' in navigator)) { self.postMessage({ type: 'ERROR', message: 'WebGPU not in worker' }); return }
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) { self.postMessage({ type: 'ERROR', message: 'no adapter' }); return }
  device = await adapter.requestDevice()
  device.lost.then((l) => self.postMessage({ type: 'DEVICE_LOST', reason: l.reason, message: l.message }))
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (!ctx) { self.postMessage({ type: 'ERROR', message: 'no webgpu context' }); return }
  context = ctx
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })

  const module = device.createShaderModule({ code: WGSL })
  pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
  uniformBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  })

  self.postMessage({ type: 'INITIALIZED' })
}

function renderOne() {
  if (!device || !context || !pipeline || !uniformBuf || !bindGroup) {
    port1.postMessage(null)
    return
  }
  const now = performance.now()
  const time = (now - t0) / 1000

  device.queue.writeBuffer(
    uniformBuf,
    0,
    new Float32Array([time, canvasW, canvasH, frameCount]),
  )
  const enc = device.createCommandEncoder()
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.draw(6)
  pass.end()
  device.queue.submit([enc.finish()])

  frameCount++
  framesSinceReport++
  if (now - lastReportT >= 500) {
    const fps = framesSinceReport / ((now - lastReportT) / 1000)
    self.postMessage({ type: 'FPS', fps, totalFrames: frameCount, elapsedSec: (now - t0) / 1000 })
    lastReportT = now
    framesSinceReport = 0
  }
  port1.postMessage(null)
}

export {}
