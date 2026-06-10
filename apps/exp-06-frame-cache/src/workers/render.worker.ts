/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

import { CACHED_WGSL } from "../shaders/cached.wgsl";
import { LRUCache } from "../lib/lru";
import { reqIdForTarget, targetFromReqId } from "../lib/reqid";
import type { CodecConfig } from "../lib/types";

type InitMsg = { type: "INIT"; canvas: OffscreenCanvas };
type LoadMsg = { type: "LOAD"; file: File };
type SeekMsg = { type: "SEEK"; targetUs: number };
type PrefetchMsg = { type: "PREFETCH"; targetUs: number };
type StatsMsg = { type: "STATS_REQ" };
type ConfigMsg = { type: "CONFIG"; vramFrames?: number; ramFrames?: number };
type InMsg = InitMsg | LoadMsg | SeekMsg | PrefetchMsg | StatsMsg | ConfigMsg;

type Tier = "vram" | "ram" | "miss";

const VRAM_DEFAULT = 60; // ~470MB at 1080p RGBA8
const RAM_DEFAULT = 200;
const PREFETCH_AHEAD = 30;
const PREFETCH_BEHIND = 10;

let canvas: OffscreenCanvas | null = null;
let device: GPUDevice | null = null;
let context: GPUCanvasContext | null = null;
let pipeline: GPURenderPipeline | null = null;
let sampler: GPUSampler | null = null;

let decoder: Worker | null = null;
let info: { config: CodecConfig; durationUs: number; sampleCount: number } | null = null;
let stepUs = Math.round(1_000_000 / 30);

let vramEvictions = 0;
let ramEvictions = 0;

const vramCache = new LRUCache<number, GPUTexture>(VRAM_DEFAULT, (_k, tex) => {
  vramEvictions++;
  tex.destroy();
});
const ramCache = new LRUCache<number, ImageBitmap>(RAM_DEFAULT, (_k, bm) => {
  ramEvictions++;
  bm.close();
});

// Pending decode requests keyed by target PTS. Multiple callers waiting on
// the same PTS are coalesced into one decoder request and resolved together.
type PendingEntry = {
  resolvers: Array<(b: ImageBitmap) => void>;
  rejectors: Array<(e: Error) => void>;
};
const pending = new Map<number, PendingEntry>();

let prefetcher: ReturnType<typeof setInterval> | null = null;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "INIT") {
      await init(e.data.canvas);
    } else if (e.data.type === "LOAD") {
      await loadFile(e.data.file);
    } else if (e.data.type === "SEEK") {
      await seekAndRender(e.data.targetUs);
    } else if (e.data.type === "PREFETCH") {
      schedulePrefetch(e.data.targetUs);
    } else if (e.data.type === "STATS_REQ") {
      reportStats();
    } else if (e.data.type === "CONFIG") {
      if (typeof e.data.vramFrames === "number") {
        vramCache.resize(e.data.vramFrames);
      }
      if (typeof e.data.ramFrames === "number") {
        ramCache.resize(e.data.ramFrames);
      }
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function init(off: OffscreenCanvas): Promise<void> {
  canvas = off;
  if (!navigator.gpu) throw new Error("WebGPU not supported");
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

  decoder = new Worker(new URL("./decode.worker.ts", import.meta.url), {
    type: "module",
  });
  decoder.onmessage = onDecodeMessage;

  self.postMessage({ type: "READY" });
}

async function loadFile(file: File): Promise<void> {
  if (!decoder) throw new Error("no decoder");
  vramCache.clear();
  ramCache.clear();
  pending.clear();
  if (prefetcher) {
    clearInterval(prefetcher);
    prefetcher = null;
  }
  decoder.postMessage({ type: "LOAD", file });
}

function onDecodeMessage(e: MessageEvent): void {
  const m = e.data;
  if (m.type === "LOADED") {
    info = {
      config: m.config,
      durationUs: m.durationUs,
      sampleCount: m.sampleCount,
    };
    if (m.config.fps && m.config.fps > 0) {
      stepUs = Math.round(1_000_000 / m.config.fps);
    }
    self.postMessage({
      type: "LOADED",
      config: m.config,
      durationUs: m.durationUs,
      sampleCount: m.sampleCount,
      keyframeCount: m.keyframeCount,
      elapsedMs: m.elapsedMs,
    });
  } else if (m.type === "FRAME") {
    void onDecodedFrame(m.reqId as string, m.frame as VideoFrame);
  } else if (m.type === "ERROR") {
    self.postMessage({ type: "ERROR", message: m.message });
  }
}

async function onDecodedFrame(reqId: string, frame: VideoFrame): Promise<void> {
  // Route by the REQUESTED key, not frame.timestamp: the decoder returns the
  // nearest sample PTS, which differs from the requested targetUs, so keying by
  // the frame's own timestamp would never match the pending/cache entries.
  const targetUs = targetFromReqId(reqId);
  // Move pixels off the GPU decoder texture into RAM as ImageBitmap so we can
  // free the VideoFrame immediately. Without this every cached frame would
  // pin a hardware decoder texture.
  const bitmap = await createImageBitmap(frame);
  frame.close();
  ramCache.set(targetUs, bitmap);
  const entry = pending.get(targetUs);
  if (entry) {
    pending.delete(targetUs);
    // resolvers + rejectors arrays drop with entry
    for (const r of entry.resolvers) r(bitmap);
  }
}

function decodeBitmap(targetUs: number): Promise<ImageBitmap> {
  if (!decoder) return Promise.reject(new Error("no decoder"));
  const cached = ramCache.get(targetUs);
  if (cached) return Promise.resolve(cached);

  return new Promise<ImageBitmap>((resolve, reject) => {
    const existing = pending.get(targetUs);
    if (existing) {
      existing.resolvers.push(resolve);
      existing.rejectors.push(reject);
      return;
    }
    const entry: PendingEntry = {
      resolvers: [resolve],
      rejectors: [reject],
    };
    pending.set(targetUs, entry);
    decoder!.postMessage({
      type: "SEEK",
      reqId: reqIdForTarget(targetUs),
      targetUs,
    });
  });
}

function uploadToVRAM(bitmap: ImageBitmap, ts: number): GPUTexture {
  if (!device) throw new Error("no device");
  const texture = device.createTexture({
    size: [bitmap.width, bitmap.height, 1],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture },
    [bitmap.width, bitmap.height],
  );
  vramCache.set(ts, texture);
  return texture;
}

async function getTexture(
  targetUs: number,
): Promise<{ texture: GPUTexture; tier: Tier }> {
  // Snap to nearest sample by step (PTS rounding). For now use raw PTS — the
  // decoder always returns the exact target PTS so cache keys line up.
  const cached = vramCache.get(targetUs);
  if (cached) return { texture: cached, tier: "vram" };

  const bitmap = ramCache.get(targetUs);
  if (bitmap) {
    const tex = uploadToVRAM(bitmap, targetUs);
    return { texture: tex, tier: "ram" };
  }

  const decoded = await decodeBitmap(targetUs);
  const tex = uploadToVRAM(decoded, targetUs);
  return { texture: tex, tier: "miss" };
}

async function seekAndRender(targetUs: number): Promise<void> {
  if (!device || !context || !pipeline || !sampler || !canvas) return;

  const t0 = performance.now();
  const { texture, tier } = await getTexture(targetUs);
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

  const t1 = performance.now();
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
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
  device.queue.submit([encoder.finish()]);
  const drawMs = performance.now() - t1;

  self.postMessage({
    type: "RENDERED",
    targetUs,
    tier,
    fetchMs,
    drawMs,
    totalMs: performance.now() - t0,
    vramSize: vramCache.size,
    ramSize: ramCache.size,
  });
}

function schedulePrefetch(centerUs: number): void {
  if (!info) return;
  if (prefetcher) {
    clearInterval(prefetcher);
    prefetcher = null;
  }
  let aheadOff = 1;
  let behindOff = 1;
  prefetcher = setInterval(() => {
    if (!info) return;
    let scheduled = 0;
    while (scheduled < 2 && aheadOff <= PREFETCH_AHEAD) {
      const ts = centerUs + aheadOff * stepUs;
      aheadOff++;
      if (ts < info.durationUs && !ramCache.has(ts) && !pending.has(ts)) {
        void decodeBitmap(ts);
        scheduled++;
      }
    }
    while (scheduled < 2 && behindOff <= PREFETCH_BEHIND) {
      const ts = centerUs - behindOff * stepUs;
      behindOff++;
      if (ts >= 0 && !ramCache.has(ts) && !pending.has(ts)) {
        void decodeBitmap(ts);
        scheduled++;
      }
    }
    if (aheadOff > PREFETCH_AHEAD && behindOff > PREFETCH_BEHIND) {
      if (prefetcher) {
        clearInterval(prefetcher);
        prefetcher = null;
      }
    }
  }, 8);
}

function reportStats(): void {
  self.postMessage({
    type: "STATS",
    vramSize: vramCache.size,
    ramSize: ramCache.size,
    vramEvictions,
    ramEvictions,
  });
}
