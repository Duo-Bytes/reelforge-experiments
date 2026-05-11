/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

import { CACHED_WGSL } from "../shaders/cached.wgsl";
import { LRUCache } from "../lib/lru";

type InitMsg = { type: "INIT"; canvas: OffscreenCanvas };
type LoadMsg = { type: "LOAD"; assetId: string; file: File };
type SeekMsg = { type: "SEEK"; assetId: string; targetUs: number };
type ClearMsg = { type: "CLEAR" };
type InMsg = InitMsg | LoadMsg | SeekMsg | ClearMsg;

const VRAM_CAP = 60;
const RAM_CAP = 200;

let canvas: OffscreenCanvas | null = null;
let device: GPUDevice | null = null;
let context: GPUCanvasContext | null = null;
let pipeline: GPURenderPipeline | null = null;
let sampler: GPUSampler | null = null;

// Per-asset decoder. Keep one decoder per loaded asset to avoid churning
// configure() across seeks.
type AssetState = {
  decoder: Worker;
};
const assets = new Map<string, AssetState>();

// Caches keyed by `${assetId}:${ptsUs}`.
const vram = new LRUCache<string, GPUTexture>(VRAM_CAP, (_k, t) => t.destroy());
const ram = new LRUCache<string, ImageBitmap>(RAM_CAP, (_k, b) => b.close());

type Pending = {
  resolvers: Array<(b: ImageBitmap) => void>;
  rejectors: Array<(e: Error) => void>;
};
const pending = new Map<string, Pending>();

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "INIT") {
      await initGPU(e.data.canvas);
    } else if (e.data.type === "LOAD") {
      await loadAsset(e.data.assetId, e.data.file);
    } else if (e.data.type === "SEEK") {
      await seekAndRender(e.data.assetId, e.data.targetUs);
    } else if (e.data.type === "CLEAR") {
      vram.clear();
      ram.clear();
      pending.clear();
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function initGPU(off: OffscreenCanvas): Promise<void> {
  canvas = off;
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  device = await adapter.requestDevice();
  context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) throw new Error("no webgpu context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const shader = device.createShaderModule({ code: CACHED_WGSL });
  pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs_main" },
    fragment: {
      module: shader,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });
  sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  self.postMessage({ type: "READY" });
}

async function loadAsset(assetId: string, file: File): Promise<void> {
  // Tear down old decoder for the same asset, if any.
  const existing = assets.get(assetId);
  if (existing) existing.decoder.terminate();

  const decoder = new Worker(new URL("./decode.worker.ts", import.meta.url), {
    type: "module",
  });
  decoder.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === "LOADED") {
      self.postMessage({
        type: "ASSET_LOADED",
        assetId,
        config: m.config,
        durationUs: m.durationUs,
        sampleCount: m.sampleCount,
        keyframeCount: m.keyframeCount,
      });
    } else if (m.type === "FRAME") {
      void onDecodedFrame(assetId, m.frame as VideoFrame);
    } else if (m.type === "ERROR") {
      self.postMessage({
        type: "ERROR",
        message: `decode[${assetId}]: ${m.message}`,
      });
    }
  };
  assets.set(assetId, { decoder });
  decoder.postMessage({ type: "LOAD", file });
}

async function onDecodedFrame(
  assetId: string,
  frame: VideoFrame,
): Promise<void> {
  const ts = frame.timestamp;
  const key = `${assetId}:${ts}`;
  const bitmap = await createImageBitmap(frame);
  frame.close();
  ram.set(key, bitmap);
  const entry = pending.get(key);
  if (entry) {
    pending.delete(key);
    for (const r of entry.resolvers) r(bitmap);
  }
}

function decodeBitmap(assetId: string, ts: number): Promise<ImageBitmap> {
  const key = `${assetId}:${ts}`;
  const cached = ram.get(key);
  if (cached) return Promise.resolve(cached);
  return new Promise<ImageBitmap>((resolve, reject) => {
    const existing = pending.get(key);
    if (existing) {
      existing.resolvers.push(resolve);
      existing.rejectors.push(reject);
      return;
    }
    pending.set(key, { resolvers: [resolve], rejectors: [reject] });
    const a = assets.get(assetId);
    if (!a) {
      reject(new Error(`asset ${assetId} not loaded`));
      return;
    }
    a.decoder.postMessage({
      type: "SEEK",
      reqId: `${assetId}-${ts}`,
      targetUs: ts,
    });
  });
}

function uploadToVRAM(
  bitmap: ImageBitmap,
  assetId: string,
  ts: number,
): GPUTexture {
  if (!device) throw new Error("no device");
  const tex = device.createTexture({
    size: [bitmap.width, bitmap.height, 1],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture: tex },
    [bitmap.width, bitmap.height],
  );
  vram.set(`${assetId}:${ts}`, tex);
  return tex;
}

async function getTexture(
  assetId: string,
  ts: number,
): Promise<{ texture: GPUTexture; tier: "vram" | "ram" | "miss" }> {
  const key = `${assetId}:${ts}`;
  const cached = vram.get(key);
  if (cached) return { texture: cached, tier: "vram" };
  const bitmap = ram.get(key);
  if (bitmap) {
    return { texture: uploadToVRAM(bitmap, assetId, ts), tier: "ram" };
  }
  const decoded = await decodeBitmap(assetId, ts);
  return { texture: uploadToVRAM(decoded, assetId, ts), tier: "miss" };
}

async function seekAndRender(assetId: string, targetUs: number): Promise<void> {
  if (!device || !context || !pipeline || !sampler || !canvas) return;
  const t0 = performance.now();
  const { texture, tier } = await getTexture(assetId, targetUs);
  const fetchMs = performance.now() - t0;

  if (canvas.width !== texture.width) canvas.width = texture.width;
  if (canvas.height !== texture.height) canvas.height = texture.height;

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: texture.createView() },
    ],
  });

  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(6);
  pass.end();
  device.queue.submit([enc.finish()]);

  self.postMessage({
    type: "RENDERED",
    assetId,
    targetUs,
    tier,
    fetchMs,
    totalMs: performance.now() - t0,
    vramSize: vram.size,
    ramSize: ram.size,
  });
}
