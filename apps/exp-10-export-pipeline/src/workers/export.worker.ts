/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

import {
  createFile,
  MP4BoxBuffer,
  type ISOFile,
  type Sample,
  type Track,
} from "mp4box";
import { serializeBoxToDescription } from "../lib/mp4box-codec";
import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  EncodedVideoPacketSource,
  EncodedPacket,
} from "mediabunny";
import {
  Muxer as MP4MuxerMuxer,
  ArrayBufferTarget as MP4MuxerArrayBufferTarget,
} from "mp4-muxer";
import { COMPOSITE_WGSL } from "../shaders/composite.wgsl";
import type { CodecConfig, VideoSample } from "../lib/types";

type ExportMsg = {
  type: "EXPORT";
  file: File;
  width: number;
  height: number;
  bitrate: number;
  fps: number;
  muxer: "mediabunny" | "mp4-muxer";
};

self.onmessage = async (e: MessageEvent<ExportMsg>) => {
  try {
    if (e.data.type === "EXPORT") {
      await runExport(e.data);
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function runExport(msg: ExportMsg): Promise<void> {
  const t0 = performance.now();
  self.postMessage({ type: "STAGE", stage: "demux" });

  const { config, samplesByDts, samplesByPts, durationUs } = await demux(
    msg.file,
  );

  self.postMessage({
    type: "DEMUXED",
    config,
    sampleCount: samplesByPts.length,
    durationUs,
  });

  const W = msg.width;
  const H = msg.height;
  const FPS = msg.fps;
  const FRAME_US = Math.round(1_000_000 / FPS);
  const totalFrames = Math.max(1, Math.round((durationUs / 1_000_000) * FPS));

  // 1) Setup WebGPU offscreen render target
  if (!navigator.gpu) throw new Error("WebGPU not supported in worker");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  const device = await adapter.requestDevice();
  const offscreen = new OffscreenCanvas(W, H);
  const ctx = offscreen.getContext("webgpu") as GPUCanvasContext | null;
  if (!ctx) throw new Error("no webgpu context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  const shader = device.createShaderModule({ code: COMPOSITE_WGSL });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs_main" },
    fragment: {
      module: shader,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformInit = new Float32Array([0, 0, 0, 0]);
  device.queue.writeBuffer(uniformBuffer, 0, uniformInit);

  // 2) Setup source decoder (single-frame deliver model)
  let pendingResolve: ((f: VideoFrame) => void) | null = null;
  let pendingTarget = -1;
  const sourceDecoder = new VideoDecoder({
    output: (frame) => {
      if (frame.timestamp === pendingTarget && pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        pendingTarget = -1;
        r(frame);
      } else {
        frame.close();
      }
    },
    error: (err) => {
      throw new Error(`source decoder: ${err.message}`);
    },
  });
  sourceDecoder.configure({
    codec: config.codec,
    description: config.description,
    codedWidth: config.width,
    codedHeight: config.height,
  });

  async function getSourceFrame(targetUs: number): Promise<VideoFrame> {
    if (pendingResolve) {
      pendingResolve = null;
      pendingTarget = -1;
    }
    // Find target sample by PTS, walk to GOP, feed in DTS order, await frame.
    let lo = 0;
    let hi = samplesByPts.length - 1;
    let targetIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (samplesByPts[mid].ptsUs <= targetUs) {
        targetIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const targetSample = samplesByPts[targetIdx];
    pendingTarget = targetSample.ptsUs;

    // GOP range
    let start = targetIdx;
    while (start > 0 && !samplesByPts[start].isKeyframe) start--;
    let end = start + 1;
    while (end < samplesByPts.length && !samplesByPts[end].isKeyframe) end++;
    const gopPts = new Set<number>();
    for (let i = start; i < end; i++) gopPts.add(samplesByPts[i].ptsUs);
    const feed = samplesByDts.filter((s) => gopPts.has(s.ptsUs));

    let minOff = Number.POSITIVE_INFINITY;
    let maxOff = 0;
    for (const s of feed) {
      if (s.offset < minOff) minOff = s.offset;
      if (s.offset + s.size > maxOff) maxOff = s.offset + s.size;
    }
    const block = new Uint8Array(
      await msg.file.slice(minOff, maxOff).arrayBuffer(),
    );

    const result = new Promise<VideoFrame>((resolve) => {
      pendingResolve = resolve;
    });

    for (const s of feed) {
      while (sourceDecoder.decodeQueueSize > 5) {
        await new Promise((r) => setTimeout(r, 1));
      }
      const data = block.subarray(
        s.offset - minOff,
        s.offset - minOff + s.size,
      );
      sourceDecoder.decode(
        new EncodedVideoChunk({
          type: s.isKeyframe ? "key" : "delta",
          timestamp: s.ptsUs,
          duration: s.durationUs,
          data,
        }),
      );
    }
    await sourceDecoder.flush();
    return Promise.race([
      result,
      new Promise<VideoFrame>((_, rej) =>
        setTimeout(() => rej(new Error(`source decode timeout @ ${targetUs}us`)), 5000),
      ),
    ]);
  }

  // 3) Setup export encoder + chosen muxer
  self.postMessage({ type: "STAGE", stage: "configure-encoder" });
  const encoderConfig: VideoEncoderConfig = {
    codec: "avc1.640028",
    width: W,
    height: H,
    bitrate: msg.bitrate,
    framerate: FPS,
    bitrateMode: "variable",
    latencyMode: "quality",
  };
  const support = await VideoEncoder.isConfigSupported(encoderConfig);
  if (!support.supported) throw new Error("export encoder unsupported");

  // Mediabunny muxer
  let mb: {
    output: Output;
    packetSource: EncodedVideoPacketSource;
    target: BufferTarget;
  } | null = null;
  // mp4-muxer muxer
  let mm: {
    muxer: InstanceType<typeof MP4MuxerMuxer>;
    target: InstanceType<typeof MP4MuxerArrayBufferTarget>;
  } | null = null;

  if (msg.muxer === "mediabunny") {
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    const packetSource = new EncodedVideoPacketSource("avc");
    output.addVideoTrack(packetSource, { frameRate: FPS });
    await output.start();
    mb = { output, packetSource, target };
  } else {
    const target = new MP4MuxerArrayBufferTarget();
    const muxer = new MP4MuxerMuxer({
      target,
      video: { codec: "avc", width: W, height: H, frameRate: FPS },
      fastStart: "in-memory",
    });
    mm = { muxer, target };
  }

  let firstMeta: EncodedVideoChunkMetadata | undefined;
  let muxedCount = 0;
  const muxAwaits: Promise<void>[] = [];

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!firstMeta && meta) firstMeta = meta;
      if (mb) {
        muxAwaits.push(
          mb.packetSource.add(
            EncodedPacket.fromEncodedChunk(chunk),
            meta ?? firstMeta,
          ),
        );
      } else if (mm) {
        mm.muxer.addVideoChunk(chunk, meta);
      }
      muxedCount++;
    },
    error: (e) => {
      throw new Error(`export encoder: ${e.message}`);
    },
  });
  encoder.configure(encoderConfig);

  // 4) Render loop
  self.postMessage({ type: "STAGE", stage: "render-loop" });
  const renderStart = performance.now();
  let lastReport = renderStart;
  const GOP_INTERVAL = 2 * FPS; // keyframe every 2s

  for (let i = 0; i < totalFrames; i++) {
    const targetUs = i * FRAME_US;
    const sourceFrame = await getSourceFrame(
      Math.min(targetUs, durationUs - 1),
    );

    // WebGPU composite (passthrough — single layer aliased to both bindings)
    const ext = device.importExternalTexture({ source: sourceFrame });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: ext },
        { binding: 2, resource: ext },
        { binding: 3, resource: { buffer: uniformBuffer } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
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
    pass.draw(6);
    pass.end();
    device.queue.submit([enc.finish()]);
    sourceFrame.close();

    // Capture canvas as a new VideoFrame for the encoder. Must happen AFTER submit.
    const out = new VideoFrame(offscreen, {
      timestamp: targetUs,
      duration: FRAME_US,
    });
    while (encoder.encodeQueueSize > 5) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const isKey = i % GOP_INTERVAL === 0;
    encoder.encode(out, { keyFrame: isKey });
    out.close();

    const now = performance.now();
    if (now - lastReport > 250) {
      lastReport = now;
      self.postMessage({
        type: "PROGRESS",
        frame: i + 1,
        total: totalFrames,
        percent: ((i + 1) / totalFrames) * 100,
        encoderQueue: encoder.encodeQueueSize,
        elapsedMs: now - renderStart,
      });
    }
  }

  // 5) Finalize
  self.postMessage({ type: "STAGE", stage: "finalize" });
  await encoder.flush();
  encoder.close();
  sourceDecoder.close();

  let buffer: ArrayBuffer;
  if (mb) {
    await Promise.all(muxAwaits);
    await mb.output.finalize();
    if (!mb.target.buffer) throw new Error("mediabunny finalize failed");
    buffer = mb.target.buffer;
  } else if (mm) {
    mm.muxer.finalize();
    buffer = mm.target.buffer;
  } else {
    throw new Error("no muxer");
  }

  // 6) Write to OPFS
  self.postMessage({ type: "STAGE", stage: "write-opfs" });
  const root = await navigator.storage.getDirectory();
  const fileName = `export_${msg.muxer}_${Date.now()}.mp4`;
  const handle = await root.getFileHandle(fileName, { create: true });
  const sync = await handle.createSyncAccessHandle();
  sync.truncate(0);
  sync.write(new Uint8Array(buffer), { at: 0 });
  sync.flush();
  sync.close();

  self.postMessage({
    type: "DONE",
    fileName,
    bytes: buffer.byteLength,
    frames: muxedCount,
    elapsedMs: performance.now() - t0,
    muxer: msg.muxer,
  });
}

async function demux(file: File): Promise<{
  config: CodecConfig;
  samplesByDts: VideoSample[];
  samplesByPts: VideoSample[];
  durationUs: number;
}> {
  const mp4: ISOFile<unknown, unknown> = createFile(false);
  let track: Track | null = null;
  let config: CodecConfig | null = null;
  const samples: VideoSample[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    mp4.onError = (err: string) => reject(new Error(err));
    mp4.onReady = (info) => {
      const vt = info.videoTracks[0];
      if (!vt) {
        reject(new Error("no video track"));
        return;
      }
      track = vt;
      const desc = extractCodecDescription(mp4, vt.id);
      config = {
        codec: vt.codec,
        description: desc,
        width: vt.video?.width ?? 0,
        height: vt.video?.height ?? 0,
        fps: vt.nb_samples / (vt.samples_duration / vt.timescale),
      };
      mp4.setExtractionOptions(vt.id, null, { nbSamples: 1000 });
      mp4.start();
      resolve();
    };
    mp4.onSamples = (_id: number, _u: unknown, batch: Sample[]) => {
      for (const s of batch) {
        samples.push({
          ptsUs: (s.cts * 1_000_000) / s.timescale,
          dtsUs: (s.dts * 1_000_000) / s.timescale,
          durationUs: (s.duration * 1_000_000) / s.timescale,
          offset: s.offset,
          size: s.size,
          isKeyframe: s.is_sync,
        });
      }
    };
  });
  let off = 0;
  while (off < file.size) {
    const end = Math.min(off + 8 * 1024 * 1024, file.size);
    const slice = await file.slice(off, end).arrayBuffer();
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(slice, off), end >= file.size);
    off = end;
  }
  mp4.flush();
  await ready;
  if (!config || !track) throw new Error("demux incomplete");
  const cfg: CodecConfig = config;
  const vt: Track = track;
  const samplesByDts = samples.slice().sort((a, b) => a.dtsUs - b.dtsUs);
  const samplesByPts = samples.slice().sort((a, b) => a.ptsUs - b.ptsUs);
  const durationUs = (vt.samples_duration * 1_000_000) / vt.timescale;
  return { config: cfg, samplesByDts, samplesByPts, durationUs };
}

function extractCodecDescription(
  mp4: ISOFile<unknown, unknown>,
  trackId: number,
): Uint8Array {
  const trak = mp4.getTrackById(trackId);
  if (!trak) throw new Error(`no trak ${trackId}`);
  const stbl = trak.mdia.minf.stbl;
  const entry = stbl.stsd.entries[0] as unknown as {
    avcC?: { write: (s: { buffer: ArrayBuffer; pos: number }) => void };
    hvcC?: { write: (s: { buffer: ArrayBuffer; pos: number }) => void };
  };
  const codecBox = entry.avcC ?? entry.hvcC;
  if (!codecBox) throw new Error("no avcC/hvcC");
  return serializeBoxToDescription(
    codecBox as unknown as Parameters<typeof serializeBoxToDescription>[0],
  );
}
