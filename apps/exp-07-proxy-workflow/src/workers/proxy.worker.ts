/// <reference lib="webworker" />

import {
  createFile,
  MP4BoxBuffer,
  type ISOFile,
  type Sample,
  type Track,
} from "mp4box";
import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  EncodedVideoPacketSource,
  EncodedPacket,
} from "mediabunny";
import { openDB, type IDBPDatabase } from "idb";
import type { CodecConfig, VideoSample } from "../lib/types";

type IngestMsg = { type: "INGEST"; file: File; fileId: string };
type TranscodeMsg = {
  type: "TRANSCODE";
  fileId: string;
  width?: number;
  height?: number;
  bitrate?: number;
  fps?: number;
};
type ListMsg = { type: "LIST" };
type ResetMsg = { type: "RESET"; fileId: string };
type InMsg = IngestMsg | TranscodeMsg | ListMsg | ResetMsg;

const PROXY_W = 1280;
const PROXY_H = 720;
const PROXY_BITRATE = 2_000_000;
const PROXY_FPS_FALLBACK = 30;

type SourceState = {
  fileId: string;
  file: File;
  config: CodecConfig;
  samplesByDts: VideoSample[];
  samplesByPts: VideoSample[];
  durationUs: number;
};

const sources = new Map<string, SourceState>();
let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB("reelforge-proxy", 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("proxies")) {
          db.createObjectStore("proxies", { keyPath: "sourceFileId" });
        }
      },
    });
  }
  return dbPromise;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "INGEST") {
      await ingest(e.data.file, e.data.fileId);
    } else if (e.data.type === "TRANSCODE") {
      await transcode(e.data);
    } else if (e.data.type === "LIST") {
      const db = await getDB();
      const all = await db.getAll("proxies");
      self.postMessage({ type: "LIST_RESULT", proxies: all });
    } else if (e.data.type === "RESET") {
      const db = await getDB();
      await db.delete("proxies", e.data.fileId);
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry(`proxy_${e.data.fileId}`);
      } catch {
        /* not present */
      }
      self.postMessage({ type: "RESET_OK", fileId: e.data.fileId });
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function ingest(file: File, fileId: string): Promise<void> {
  // Stream-write source into OPFS so the original is available for export
  // even after the user closes the file picker.
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(fileId, { create: true });
  const sync = await handle.createSyncAccessHandle();
  try {
    sync.truncate(0);
    const CHUNK = 8 * 1024 * 1024;
    let off = 0;
    while (off < file.size) {
      const end = Math.min(off + CHUNK, file.size);
      const slice = await file.slice(off, end).arrayBuffer();
      sync.write(new Uint8Array(slice), { at: off });
      off = end;
    }
  } finally {
    sync.flush();
    sync.close();
  }

  const t0 = performance.now();
  const mp4: ISOFile<unknown, unknown> = createFile(false);
  let track: Track | null = null;
  let codecConfig: CodecConfig | null = null;
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
      const description = extractCodecDescription(mp4, vt.id);
      const fps = vt.nb_samples / (vt.samples_duration / vt.timescale);
      codecConfig = {
        codec: vt.codec,
        description,
        width: vt.video?.width ?? 0,
        height: vt.video?.height ?? 0,
        fps,
      };
      mp4.setExtractionOptions(vt.id, null, { nbSamples: 1000 });
      mp4.start();
      resolve();
    };
    mp4.onSamples = (_id: number, _user: unknown, batch: Sample[]) => {
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

  let off2 = 0;
  while (off2 < file.size) {
    const end = Math.min(off2 + 8 * 1024 * 1024, file.size);
    const slice = await file.slice(off2, end).arrayBuffer();
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(slice, off2), end >= file.size);
    off2 = end;
  }
  mp4.flush();
  await ready;

  if (!codecConfig || !track) throw new Error("demux incomplete");
  const vt: Track = track;
  const cfg: CodecConfig = codecConfig;

  const samplesByDts = samples.slice().sort((a, b) => a.dtsUs - b.dtsUs);
  const samplesByPts = samples.slice().sort((a, b) => a.ptsUs - b.ptsUs);
  const durationUs = (vt.samples_duration * 1_000_000) / vt.timescale;

  sources.set(fileId, {
    fileId,
    file,
    config: cfg,
    samplesByDts,
    samplesByPts,
    durationUs,
  });

  self.postMessage({
    type: "INGESTED",
    fileId,
    config: cfg,
    sampleCount: samples.length,
    keyframeCount: samples.filter((s) => s.isKeyframe).length,
    durationUs,
    elapsedMs: performance.now() - t0,
  });
}

async function transcode(msg: TranscodeMsg): Promise<void> {
  const src = sources.get(msg.fileId);
  if (!src) throw new Error(`source not ingested: ${msg.fileId}`);

  const targetW = msg.width ?? PROXY_W;
  const targetH = msg.height ?? PROXY_H;
  const bitrate = msg.bitrate ?? PROXY_BITRATE;
  const targetFps =
    msg.fps ?? (src.config.fps > 0 ? Math.round(src.config.fps) : PROXY_FPS_FALLBACK);

  const t0 = performance.now();

  // Source decoder
  const decoderOutput: VideoFrame[] = [];
  const decoder = new VideoDecoder({
    output: (f) => decoderOutput.push(f),
    error: (e) => {
      throw new Error(`source decoder: ${e.message}`);
    },
  });
  decoder.configure({
    codec: src.config.codec,
    description: src.config.description,
    codedWidth: src.config.width,
    codedHeight: src.config.height,
  });

  // Proxy encoder
  const encoderConfig: VideoEncoderConfig = {
    codec: "avc1.4d0028",
    width: targetW,
    height: targetH,
    bitrate,
    framerate: targetFps,
    bitrateMode: "variable",
    latencyMode: "quality",
  };
  const support = await VideoEncoder.isConfigSupported(encoderConfig);
  if (!support.supported) {
    throw new Error("H.264 720p encoder not supported");
  }

  // Mediabunny output
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target,
  });
  const packetSource = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(packetSource, {
    frameRate: targetFps,
  });
  await output.start();

  let firstChunkMeta: EncodedVideoChunkMetadata | undefined;
  let muxedCount = 0;
  const muxAwaits: Promise<void>[] = [];

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!firstChunkMeta && meta) firstChunkMeta = meta;
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      muxAwaits.push(packetSource.add(packet, meta ?? firstChunkMeta));
      muxedCount++;
    },
    error: (e) => {
      throw new Error(`proxy encoder: ${e.message}`);
    },
  });
  encoder.configure(encoderConfig);

  // OffscreenCanvas scaler
  const scaleCanvas = new OffscreenCanvas(targetW, targetH);
  const scaleCtx = scaleCanvas.getContext("2d", { alpha: false });
  if (!scaleCtx) throw new Error("no 2d context for scale canvas");

  // Feed source samples in DTS order. Decoder emits VideoFrames in PTS order.
  // We pump samples in chunks, drain decoder output, scale + encode.
  const samples = src.samplesByDts;
  const totalSamples = samples.length;

  // Pre-read all sample bytes via single block-read per file. For a large
  // file this could be split into chunks; for the experiment we accept
  // whole-file slice for simplicity.
  let progressTs = 0;
  let lastReport = 0;

  for (let i = 0; i < totalSamples; i++) {
    const s = samples[i];
    while (decoder.decodeQueueSize > 5) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const bytes = new Uint8Array(
      await src.file.slice(s.offset, s.offset + s.size).arrayBuffer(),
    );
    decoder.decode(
      new EncodedVideoChunk({
        type: s.isKeyframe ? "key" : "delta",
        timestamp: s.ptsUs,
        duration: s.durationUs,
        data: bytes,
      }),
    );

    // Drain decoder output as it becomes available.
    while (decoderOutput.length > 0) {
      const sourceFrame = decoderOutput.shift()!;
      const ts = sourceFrame.timestamp;
      const dur = sourceFrame.duration ?? Math.round(1_000_000 / targetFps);
      scaleCtx.drawImage(sourceFrame, 0, 0, targetW, targetH);
      sourceFrame.close();
      const scaled = new VideoFrame(scaleCanvas, {
        timestamp: ts,
        duration: dur,
      });
      while (encoder.encodeQueueSize > 5) {
        await new Promise((r) => setTimeout(r, 1));
      }
      encoder.encode(scaled, { keyFrame: true });
      scaled.close();

      progressTs = ts;
      const now = performance.now();
      if (now - lastReport > 250) {
        lastReport = now;
        self.postMessage({
          type: "PROGRESS",
          fileId: msg.fileId,
          percent: Math.min(100, (progressTs / src.durationUs) * 100),
          encoded: muxedCount,
          total: totalSamples,
        });
      }
    }
  }

  await decoder.flush();
  // Drain remaining frames
  while (decoderOutput.length > 0) {
    const sourceFrame = decoderOutput.shift()!;
    const ts = sourceFrame.timestamp;
    const dur = sourceFrame.duration ?? Math.round(1_000_000 / targetFps);
    scaleCtx.drawImage(sourceFrame, 0, 0, targetW, targetH);
    sourceFrame.close();
    const scaled = new VideoFrame(scaleCanvas, {
      timestamp: ts,
      duration: dur,
    });
    encoder.encode(scaled, { keyFrame: true });
    scaled.close();
  }

  await encoder.flush();
  encoder.close();
  decoder.close();

  // Wait for all muxer adds to settle.
  await Promise.all(muxAwaits);
  await output.finalize();
  if (!target.buffer) throw new Error("muxer produced no buffer");

  // Write proxy to OPFS
  const proxyId = `proxy_${msg.fileId}`;
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(proxyId, { create: true });
  const sync = await handle.createSyncAccessHandle();
  try {
    sync.truncate(0);
    sync.write(new Uint8Array(target.buffer), { at: 0 });
  } finally {
    sync.flush();
    sync.close();
  }

  // Store metadata
  const db = await getDB();
  const meta = {
    sourceFileId: msg.fileId,
    proxyFileId: proxyId,
    width: targetW,
    height: targetH,
    bitrate,
    fps: targetFps,
    durationUs: src.durationUs,
    proxyBytes: target.buffer.byteLength,
    encodedFrames: muxedCount,
    createdAt: Date.now(),
  };
  await db.put("proxies", meta);

  self.postMessage({
    type: "DONE",
    fileId: msg.fileId,
    meta,
    elapsedMs: performance.now() - t0,
  });
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
  const withData = codecBox as unknown as { data?: ArrayBufferLike };
  if (withData.data) return new Uint8Array(withData.data);
  const buffer = new ArrayBuffer(8 * 1024);
  const stream = { buffer, pos: 0 };
  codecBox.write(stream);
  return new Uint8Array(buffer, 8, stream.pos - 8);
}
