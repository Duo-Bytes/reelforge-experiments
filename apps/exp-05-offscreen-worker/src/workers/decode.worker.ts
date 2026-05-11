/// <reference lib="webworker" />

import {
  createFile,
  MP4BoxBuffer,
  type ISOFile,
  type Sample,
  type Track,
} from "mp4box";
import type { CodecConfig, VideoSample, GopRange } from "../lib/types";

type LoadMsg = { type: "LOAD"; file: File };
type SeekMsg = { type: "SEEK"; reqId: string; targetUs: number };
type StressMsg = { type: "STRESS"; iterations: number };
type CloseMsg = { type: "CLOSE" };
type InMsg = LoadMsg | SeekMsg | StressMsg | CloseMsg;

type LoadedState = {
  file: File;
  config: CodecConfig;
  samplesByDts: VideoSample[];
  samplesByPts: VideoSample[];
  durationUs: number;
};

type FrameResult = { frame: VideoFrame; decodeMs: number; peakQueueSize: number };

let state: LoadedState | null = null;
let decoder: VideoDecoder | null = null;
let configReady = false;
let targetTimestampUs: number | null = null;
let activeResolve: ((r: FrameResult) => void) | null = null;
let activeReject: ((e: Error) => void) | null = null;
let activeSeekStart = 0;
let peakQueueSize = 0;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "LOAD") {
      await load(e.data.file);
    } else if (e.data.type === "SEEK") {
      const result = await seek(e.data.targetUs);
      self.postMessage(
        {
          type: "FRAME",
          reqId: e.data.reqId,
          frame: result.frame,
          decodeMs: result.decodeMs,
          peakQueueSize: result.peakQueueSize,
        },
        [result.frame as unknown as Transferable],
      );
    } else if (e.data.type === "STRESS") {
      await stress(e.data.iterations);
    } else if (e.data.type === "CLOSE") {
      shutdown();
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function load(file: File): Promise<void> {
  shutdown();

  const t0 = performance.now();
  const mp4: ISOFile<unknown, unknown> = createFile(false);

  const samples: VideoSample[] = [];
  let track: Track | null = null;
  let codecConfig: CodecConfig | null = null;

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

  const CHUNK = 8 * 1024 * 1024;
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK, file.size);
    const slice = await file.slice(offset, end).arrayBuffer();
    const last = end >= file.size;
    const wrapped = MP4BoxBuffer.fromArrayBuffer(slice, offset);
    mp4.appendBuffer(wrapped, last);
    offset = end;
  }
  mp4.flush();

  await ready;

  if (!codecConfig || !track) throw new Error("demux incomplete");
  const vt: Track = track;
  const cfg: CodecConfig = codecConfig;

  const samplesByDts = samples.slice().sort((a, b) => a.dtsUs - b.dtsUs);
  const samplesByPts = samples.slice().sort((a, b) => a.ptsUs - b.ptsUs);
  const durationUs = (vt.samples_duration * 1_000_000) / vt.timescale;

  state = {
    file,
    config: cfg,
    samplesByDts,
    samplesByPts,
    durationUs,
  };

  // Verify codec support, then build decoder.
  const support = await VideoDecoder.isConfigSupported({
    codec: cfg.codec,
    description: cfg.description,
    codedWidth: cfg.width,
    codedHeight: cfg.height,
  });
  if (!support.supported) {
    throw new Error(
      `VideoDecoder rejected codec ${cfg.codec} (size ${cfg.width}x${cfg.height})`,
    );
  }

  decoder = new VideoDecoder({
    output: handleFrame,
    error: (err: DOMException) => {
      self.postMessage({ type: "ERROR", message: `decoder: ${err.message}` });
    },
  });
  decoder.configure({
    codec: cfg.codec,
    description: cfg.description,
    codedWidth: cfg.width,
    codedHeight: cfg.height,
  });
  configReady = true;

  const elapsedMs = performance.now() - t0;
  self.postMessage({
    type: "LOADED",
    config: cfg,
    sampleCount: samples.length,
    keyframeCount: samples.filter((s) => s.isKeyframe).length,
    durationUs,
    elapsedMs,
  });
}

function handleFrame(frame: VideoFrame): void {
  if (frame.timestamp === targetTimestampUs && activeResolve) {
    const decodeMs = performance.now() - activeSeekStart;
    const resolve = activeResolve;
    targetTimestampUs = null;
    activeResolve = null;
    activeReject = null;
    resolve({ frame, decodeMs, peakQueueSize });
  } else {
    frame.close();
  }
}

async function seek(targetUs: number): Promise<FrameResult> {
  if (!state || !decoder || !configReady) {
    throw new Error("LOAD before SEEK");
  }
  if (activeResolve) throw new Error("seek in progress");

  const samples = state.samplesByPts;
  if (samples.length === 0) throw new Error("no samples");

  // Find target sample by PTS.
  let lo = 0;
  let hi = samples.length - 1;
  let targetIdx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].ptsUs <= targetUs) {
      targetIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const targetSample = samples[targetIdx];
  targetTimestampUs = targetSample.ptsUs;
  activeSeekStart = performance.now();
  peakQueueSize = 0;

  const framePromise = new Promise<FrameResult>((resolve, reject) => {
    activeResolve = resolve;
    activeReject = reject;
  });

  // Compute GOP in PTS space, then map to DTS-ordered feed list.
  const gop = gopRange(samples, targetIdx);
  if (!gop) throw new Error("no GOP");

  const gopPtsSet = new Set<number>();
  for (let i = gop.startIdx; i < gop.endIdx; i++) {
    gopPtsSet.add(samples[i].ptsUs);
  }
  // Feed in DTS order, but only the GOP we care about.
  const feedList: VideoSample[] = state.samplesByDts.filter((s) =>
    gopPtsSet.has(s.ptsUs),
  );

  // Pre-read all bytes in one slice to avoid per-sample I/O overhead.
  let minOff = Number.POSITIVE_INFINITY;
  let maxOff = 0;
  for (const s of feedList) {
    if (s.offset < minOff) minOff = s.offset;
    if (s.offset + s.size > maxOff) maxOff = s.offset + s.size;
  }
  const blockBuf = await state.file
    .slice(minOff, maxOff)
    .arrayBuffer();
  const block = new Uint8Array(blockBuf);

  for (const s of feedList) {
    while (decoder.decodeQueueSize > 5) {
      await new Promise((r) => setTimeout(r, 1));
    }
    if (decoder.decodeQueueSize > peakQueueSize) {
      peakQueueSize = decoder.decodeQueueSize;
    }
    const data = block.subarray(s.offset - minOff, s.offset - minOff + s.size);
    decoder.decode(
      new EncodedVideoChunk({
        type: s.isKeyframe ? "key" : "delta",
        timestamp: s.ptsUs,
        duration: s.durationUs,
        data,
      }),
    );
  }
  // flush() forces buffered frames out, output callback fires async.
  await decoder.flush();

  return framePromise;
}

function gopRange(samples: VideoSample[], targetIdx: number): GopRange | null {
  if (samples.length === 0) return null;
  let start = targetIdx;
  while (start > 0 && !samples[start].isKeyframe) start--;
  let end = start + 1;
  while (end < samples.length && !samples[end].isKeyframe) end++;
  const first = samples[start];
  const last = samples[end - 1];
  return {
    startIdx: start,
    endIdx: end,
    byteStart: first.offset,
    byteEnd: last.offset + last.size,
    frameCount: end - start,
  };
}

async function stress(iterations: number): Promise<void> {
  if (!state) throw new Error("LOAD before STRESS");
  const totalUs = state.durationUs;
  const latencies: number[] = [];
  let peak = 0;

  for (let i = 0; i < iterations; i++) {
    const targetUs = Math.floor(Math.random() * totalUs);
    const result = await seek(targetUs);
    latencies.push(result.decodeMs);
    if (result.peakQueueSize > peak) peak = result.peakQueueSize;
    result.frame.close();
  }

  latencies.sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  self.postMessage({
    type: "STRESS_RESULT",
    iterations,
    median,
    p95,
    min: latencies[0],
    max: latencies[latencies.length - 1],
    peakQueueSize: peak,
  });
}

function shutdown(): void {
  if (decoder) {
    try {
      decoder.close();
    } catch {
      /* already closed */
    }
    decoder = null;
  }
  if (activeReject) {
    activeReject(new Error("decoder closed"));
  }
  configReady = false;
  state = null;
  targetTimestampUs = null;
  activeResolve = null;
  activeReject = null;
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
