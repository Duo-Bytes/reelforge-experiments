/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />
/**
 * Sandboxed plugin worker for exp-38.
 *
 * Compiles plugin WGSL for real via GPUDevice.createShaderModule, surfaces
 * genuine getCompilationInfo() diagnostics, builds a render pipeline, and
 * previews the effect over a host-generated base texture on a transferred
 * OffscreenCanvas. Running in a dedicated worker isolates plugin code and
 * GPU validation failures from the main thread / React UI.
 */

import { packParams, type ParamSpec, type ParamValue } from "../lib/plugin";

// Host vertex stage: a full-screen triangle that emits uv in [0,1].
const HOST_VS = `
@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0), vec2<f32>(-1.0, 1.0), vec2<f32>(3.0, 1.0));
  var out: VSOut;
  let p = pos[vid];
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
`;

type InitMsg = { type: "INIT"; canvas: OffscreenCanvas };
type CompileMsg = { type: "COMPILE"; code: string; params: ParamSpec[] };
type ParamsMsg = { type: "PARAMS"; values: Record<string, ParamValue>; specs: ParamSpec[] };
type InMsg = InitMsg | CompileMsg | ParamsMsg;

let device: GPUDevice | null = null;
let ctx: GPUCanvasContext | null = null;
let format: GPUTextureFormat = "bgra8unorm";
let sampler: GPUSampler | null = null;
let baseView: GPUTextureView | null = null;
let uniformBuf: GPUBuffer | null = null;
let pipeline: GPURenderPipeline | null = null;
let bindGroup: GPUBindGroup | null = null;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "INIT") await init(e.data.canvas);
    else if (e.data.type === "COMPILE") await compile(e.data.code, e.data.params);
    else if (e.data.type === "PARAMS") updateParams(e.data.values, e.data.specs);
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function init(canvas: OffscreenCanvas): Promise<void> {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  device = await adapter.requestDevice();
  device.lost.then((info) => {
    self.postMessage({ type: "ERROR", message: `device lost: ${info.message}` });
  });

  ctx = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!ctx) throw new Error("no webgpu context");
  format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  baseView = makeBaseTexture(device).createView();
  // 64 bytes is plenty for any reasonable Params struct in this demo.
  uniformBuf = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  self.postMessage({ type: "READY" });
}

/** Generate a gradient + bright circle so glow/filter effects are visible. */
function makeBaseTexture(dev: GPUDevice): GPUTexture {
  const W = 512;
  const H = 256;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // diagonal gradient base
      const g = (x / W) * 0.5 + (y / H) * 0.5;
      let r = 30 + g * 40;
      let gg = 40 + g * 50;
      let b = 60 + g * 80;
      // bright central disc
      const dx = x - W / 2;
      const dy = y - H / 2;
      const d = Math.sqrt(dx * dx + dy * dy);
      const disc = Math.max(0, 1 - d / 70);
      r += disc * 200;
      gg += disc * 200;
      b += disc * 180;
      data[i] = Math.min(255, r);
      data[i + 1] = Math.min(255, gg);
      data[i + 2] = Math.min(255, b);
      data[i + 3] = 255;
    }
  }
  const tex = dev.createTexture({
    size: [W, H],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  dev.queue.writeTexture({ texture: tex }, data, { bytesPerRow: W * 4, rowsPerImage: H }, [W, H]);
  return tex;
}

async function compile(code: string, params: ParamSpec[]): Promise<void> {
  if (!device || !sampler || !baseView || !uniformBuf) {
    throw new Error("worker not initialised");
  }
  const t0 = performance.now();

  // Compile host vertex + plugin fragment in one module so they share the
  // uv interface. Real WGSL diagnostics come from getCompilationInfo().
  const shaderModule = device.createShaderModule({ code: `${HOST_VS}\n${code}` });
  const info = await shaderModule.getCompilationInfo();
  const messages = info.messages.map((m) => ({
    type: m.type,
    message: m.message,
    line: m.lineNum,
  }));
  if (messages.some((m) => m.type === "error")) {
    self.postMessage({ type: "COMPILED", ok: false, ms: performance.now() - t0, messages });
    return;
  }

  // Catch pipeline-creation validation errors instead of crashing the worker.
  device.pushErrorScope("validation");
  let newPipeline: GPURenderPipeline | null = null;
  try {
    newPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: { module: shaderModule, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  } catch (err) {
    messages.push({ type: "error", message: String(err), line: 0 });
  }
  const validationError = await device.popErrorScope();
  if (validationError || !newPipeline) {
    if (validationError) {
      messages.push({ type: "error", message: validationError.message, line: 0 });
    }
    self.postMessage({ type: "COMPILED", ok: false, ms: performance.now() - t0, messages });
    return;
  }

  pipeline = newPipeline;
  bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: baseView },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: uniformBuf } },
    ],
  });

  // Seed uniforms from defaults, then render.
  const seed = packParams(params, {});
  device.queue.writeBuffer(uniformBuf, 0, seed.buffer, seed.byteOffset, seed.byteLength);
  render();

  self.postMessage({ type: "COMPILED", ok: true, ms: performance.now() - t0, messages });
}

function updateParams(values: Record<string, ParamValue>, specs: ParamSpec[]): void {
  if (!device || !uniformBuf) return;
  const packed = packParams(specs, values);
  device.queue.writeBuffer(uniformBuf, 0, packed.buffer, packed.byteOffset, packed.byteLength);
  render();
}

function render(): void {
  if (!device || !ctx || !pipeline || !bindGroup) return;
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

export {};
