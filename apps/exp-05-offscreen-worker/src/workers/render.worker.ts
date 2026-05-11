/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

import { COMPOSITE_WGSL } from "../shaders/composite.wgsl";
import type { CodecConfig } from "../lib/types";

type InitMsg = { type: "INIT"; canvas: OffscreenCanvas; dpr: number };
type LoadMsg = { type: "LOAD"; file: File };
type PlayMsg = { type: "PLAY"; fps?: number };
type PauseMsg = { type: "PAUSE" };
type SeekMsg = { type: "SEEK"; targetUs: number };
type InMsg = InitMsg | LoadMsg | PlayMsg | PauseMsg | SeekMsg;

let canvas: OffscreenCanvas | null = null;
let device: GPUDevice | null = null;
let context: GPUCanvasContext | null = null;
let pipeline: GPURenderPipeline | null = null;
let sampler: GPUSampler | null = null;
let uniformBuffer: GPUBuffer | null = null;

let decoder: Worker | null = null;
let info: {
  config: CodecConfig;
  durationUs: number;
  sampleCount: number;
  keyframeCount: number;
} | null = null;

let currentFrame: VideoFrame | null = null;
let isPlaying = false;
let playheadUs = 0;
let stepUs = Math.round(1_000_000 / 30); // overwritten on LOAD with real fps
let lastTickMs = 0;
let renderedFrames = 0;
let lastFpsReportMs = 0;

const channel = new MessageChannel();
channel.port2.onmessage = () => {
  if (!isPlaying) return;
  tick();
  channel.port1.postMessage(null);
};

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "INIT") {
      await init(e.data.canvas, e.data.dpr);
    } else if (e.data.type === "LOAD") {
      await loadFile(e.data.file);
    } else if (e.data.type === "PLAY") {
      if (e.data.fps && e.data.fps > 0) {
        stepUs = Math.round(1_000_000 / e.data.fps);
      }
      isPlaying = true;
      lastTickMs = performance.now();
      renderedFrames = 0;
      lastFpsReportMs = lastTickMs;
      channel.port1.postMessage(null);
    } else if (e.data.type === "PAUSE") {
      isPlaying = false;
    } else if (e.data.type === "SEEK") {
      isPlaying = false;
      playheadUs = e.data.targetUs;
      requestFrame(playheadUs);
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function init(off: OffscreenCanvas, dpr: number): Promise<void> {
  canvas = off;
  if (!navigator.gpu) throw new Error("WebGPU not supported");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  device = await adapter.requestDevice();

  context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) throw new Error("no webgpu context on offscreen canvas");

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const shader = device.createShaderModule({ code: COMPOSITE_WGSL });
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
  uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Spawn decode sub-worker. Render worker owns it.
  decoder = new Worker(new URL("./decode.worker.ts", import.meta.url), {
    type: "module",
  });
  decoder.onmessage = onDecodeMessage;

  self.postMessage({ type: "READY", dpr });
}

async function loadFile(file: File): Promise<void> {
  if (!decoder) throw new Error("decoder not initialized");
  isPlaying = false;
  if (currentFrame) {
    currentFrame.close();
    currentFrame = null;
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
      keyframeCount: m.keyframeCount,
    };
    if (m.config.fps && m.config.fps > 0) {
      stepUs = Math.round(1_000_000 / m.config.fps);
    }
    playheadUs = 0;
    self.postMessage({
      type: "LOADED",
      config: m.config,
      durationUs: m.durationUs,
      sampleCount: m.sampleCount,
      keyframeCount: m.keyframeCount,
      elapsedMs: m.elapsedMs,
    });
    requestFrame(0);
  } else if (m.type === "FRAME") {
    if (currentFrame) currentFrame.close();
    currentFrame = m.frame as VideoFrame;
    drawCurrent();
  } else if (m.type === "ERROR") {
    self.postMessage({ type: "ERROR", message: m.message });
  }
}

function requestFrame(targetUs: number): void {
  if (!decoder) return;
  decoder.postMessage({
    type: "SEEK",
    reqId: crypto.randomUUID(),
    targetUs,
  });
}

function tick(): void {
  if (!info) return;
  const now = performance.now();
  const elapsedMs = now - lastTickMs;
  lastTickMs = now;
  // Advance playhead by real time, not vsync count, to keep wall-clock pace.
  playheadUs += Math.round(elapsedMs * 1000);
  if (playheadUs >= info.durationUs) {
    playheadUs = 0; // simple loop
  }
  requestFrame(playheadUs);

  // FPS reporting once a second.
  renderedFrames++;
  if (now - lastFpsReportMs >= 1000) {
    self.postMessage({
      type: "STATS",
      fps: renderedFrames / ((now - lastFpsReportMs) / 1000),
      playheadUs,
      stepUs,
    });
    renderedFrames = 0;
    lastFpsReportMs = now;
  }
}

function drawCurrent(): void {
  if (!device || !context || !pipeline || !sampler || !uniformBuffer) return;
  if (!currentFrame) return;

  // Resize canvas if needed to match frame dimensions.
  if (canvas) {
    if (canvas.width !== currentFrame.displayWidth) {
      canvas.width = currentFrame.displayWidth;
    }
    if (canvas.height !== currentFrame.displayHeight) {
      canvas.height = currentFrame.displayHeight;
    }
  }

  const u = new Float32Array(4);
  u[0] = 0;
  u[1] = 0; // useTop = 0 (single layer in this experiment)
  device.queue.writeBuffer(uniformBuffer, 0, u);

  const ext = device.importExternalTexture({ source: currentFrame });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: ext },
      { binding: 2, resource: ext },
      { binding: 3, resource: { buffer: uniformBuffer } },
    ],
  });

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
}
