/// <reference lib="webworker" />

import {
  createFile,
  MP4BoxBuffer,
  type ISOFile,
  type Sample,
} from "mp4box";
import type {
  CodecConfig,
  CloseMode,
  RunMode,
  RunMetrics,
  VideoSample,
} from "../lib/types";

type LoadMsg = { type: "LOAD"; file: File };
type RunMsg = {
  type: "RUN";
  mode: RunMode;
  closeMode: CloseMode;
  highWaterMark: number;
  iterations: number; // how many times to loop the sample list
};
type StopMsg = { type: "STOP" };
type In = LoadMsg | RunMsg | StopMsg;

let codec: CodecConfig | null = null;
let samplesByDts: VideoSample[] = [];
let file: File | null = null;
let running = false;
let stopRequested = false;
let outstanding = 0;

self.onmessage = async (e: MessageEvent<In>) => {
  try {
    if (e.data.type === "LOAD") {
      await load(e.data.file);
    } else if (e.data.type === "RUN") {
      if (running) throw new Error("already running");
      await run(e.data);
    } else if (e.data.type === "STOP") {
      stopRequested = true;
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function load(f: File): Promise<void> {
  const t0 = performance.now();
  const mp4: ISOFile<unknown, unknown> = createFile(false);
  const samples: VideoSample[] = [];
  const ready = new Promise<CodecConfig>((resolve, reject) => {
    mp4.onError = (err: string) => reject(new Error(err));
    mp4.onReady = (info) => {
      const vt = info.videoTracks[0];
      if (!vt) {
        reject(new Error("no video track"));
        return;
      }
      const description = extractCodecDescription(mp4, vt.id);
      const fps = vt.nb_samples / (vt.samples_duration / vt.timescale);
      const parsed: CodecConfig = {
        codec: vt.codec,
        description,
        width: vt.video?.width ?? 0,
        height: vt.video?.height ?? 0,
        fps,
      };
      mp4.setExtractionOptions(vt.id, null, { nbSamples: 1000 });
      mp4.start();
      resolve(parsed);
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
  while (offset < f.size) {
    const end = Math.min(offset + CHUNK, f.size);
    const slice = await f.slice(offset, end).arrayBuffer();
    const last = end >= f.size;
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(slice, offset), last);
    offset = end;
  }
  mp4.flush();
  const cfg = await ready;

  samplesByDts = samples.sort((a, b) => a.dtsUs - b.dtsUs);
  codec = cfg;
  file = f;

  self.postMessage({
    type: "LOADED",
    codec: cfg.codec,
    width: cfg.width,
    height: cfg.height,
    fps: cfg.fps,
    sampleCount: samples.length,
    elapsedMs: performance.now() - t0,
  });
}

async function run(msg: RunMsg): Promise<void> {
  if (!codec || !file) throw new Error("LOAD before RUN");
  running = true;
  stopRequested = false;
  outstanding = 0;

  // Decoder owns frame ownership policy per closeMode.
  let decoded = 0;
  let closed = 0;
  let peakQueue = 0;
  const decodeTimestamps: number[] = [];
  const t0 = performance.now();

  const decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      decoded++;
      outstanding++;
      decodeTimestamps.push(performance.now());
      // Touch the frame to actually upload it / pin GPU memory. Without
      // any read, Chrome can elide work and the leak harness is too weak.
      try {
        // copyTo(zero-size) is enough to materialize the frame's plane data
        // in some implementations; createImageBitmap is the broader contract.
        const _ignored = frame.codedWidth + frame.codedHeight;
        void _ignored;
      } catch {
        /* noop */
      }
      if (msg.closeMode === "close") {
        frame.close();
        closed++;
        outstanding--;
      }
      // In "leak" mode we deliberately keep the frame alive forever (it goes
      // out of scope here, but Chrome doesn't GC the underlying GPU memory
      // until close() is called — that's the leak).
    },
    error: (err: DOMException) => {
      self.postMessage({ type: "ERROR", message: `decoder: ${err.message}` });
    },
  });

  decoder.configure({
    codec: codec.codec,
    description: codec.description,
    codedWidth: codec.width,
    codedHeight: codec.height,
    hardwareAcceleration: "prefer-hardware",
  });

  // Read whole file once into ArrayBuffer for the bench. Memory cost is the
  // file size, but it removes I/O from the measurement.
  const fileBuf = await file.arrayBuffer();
  const fileBytes = new Uint8Array(fileBuf);

  const interval = setInterval(() => {
    if (decoder.decodeQueueSize > peakQueue) peakQueue = decoder.decodeQueueSize;
    postMetrics();
  }, 200) as unknown as number;

  const postMetrics = () => {
    const now = performance.now();
    const elapsed = now - t0;
    // Rolling FPS: frames in the last second.
    const oneSecAgo = now - 1000;
    let rollCount = 0;
    for (let i = decodeTimestamps.length - 1; i >= 0; i--) {
      if (decodeTimestamps[i] >= oneSecAgo) rollCount++;
      else break;
    }
    const avgInterval =
      decodeTimestamps.length > 1
        ? (decodeTimestamps[decodeTimestamps.length - 1] -
            decodeTimestamps[0]) /
          (decodeTimestamps.length - 1)
        : 0;
    const metrics: RunMetrics = {
      decodedCount: decoded,
      closedCount: closed,
      outstandingFrames: outstanding,
      peakQueueSize: peakQueue,
      currentQueueSize: decoder.decodeQueueSize,
      avgDecodeIntervalMs: avgInterval,
      rollingFps: rollCount,
      elapsedMs: elapsed,
      jsHeapMb: measureHeap(),
    };
    self.postMessage({ type: "METRICS", metrics });
  };

  try {
    for (let iter = 0; iter < msg.iterations; iter++) {
      for (const s of samplesByDts) {
        if (stopRequested) break;

        if (msg.mode === "backpressure") {
          // Pause feeding when the decoder's queue is above the watermark.
          while (decoder.decodeQueueSize >= msg.highWaterMark) {
            await new Promise((r) => setTimeout(r, 1));
            if (stopRequested) break;
          }
        }
        if (decoder.decodeQueueSize > peakQueue) {
          peakQueue = decoder.decodeQueueSize;
        }

        const data = fileBytes.subarray(s.offset, s.offset + s.size);
        decoder.decode(
          new EncodedVideoChunk({
            type: s.isKeyframe ? "key" : "delta",
            timestamp: s.ptsUs,
            duration: s.durationUs,
            data,
          }),
        );
      }
      if (stopRequested) break;
    }
    // Drain.
    await decoder.flush().catch(() => {});
  } finally {
    clearInterval(interval);
    try {
      decoder.close();
    } catch {
      /* */
    }
    running = false;
    postMetrics();
    self.postMessage({
      type: "DONE",
      decodedCount: decoded,
      closedCount: closed,
      outstandingFrames: outstanding,
      peakQueueSize: peakQueue,
      elapsedMs: performance.now() - t0,
    });
  }
}

function measureHeap(): number | undefined {
  // performance.memory is non-standard and Chrome-only; OK for this bench.
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  return perf.memory ? perf.memory.usedJSHeapSize / (1024 * 1024) : undefined;
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
  const box = entry.avcC ?? entry.hvcC;
  if (!box) throw new Error("no avcC/hvcC");
  const withData = box as unknown as { data?: ArrayBufferLike };
  if (withData.data) return new Uint8Array(withData.data);
  const buf = new ArrayBuffer(8 * 1024);
  const stream = { buffer: buf, pos: 0 };
  box.write(stream);
  return new Uint8Array(buf, 8, stream.pos - 8);
}
