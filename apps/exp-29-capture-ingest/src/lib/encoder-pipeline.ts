/**
 * Track → MediaStreamTrackProcessor → VideoEncoder → OPFS pipeline.
 */

import {
  appendChunk,
  closeSession,
  openSession,
  type SessionHandles,
  type SessionMeta,
} from "./opfs-session";
import { RollingAverage } from "./stats";

export type PipelineStats = {
  inputFps: number;
  encodeQueueSize: number;
  bitrateKbps: number;
  bytesWritten: number;
  droppedFrames: number;
};

export type PipelineHandle = {
  stop: () => Promise<void>;
  getStats: () => PipelineStats;
  getSession: () => SessionHandles;
};

export type PipelineOptions = {
  track: MediaStreamTrack;
  source: "screen" | "camera";
  codec: string;
  width: number;
  height: number;
  bitrate?: number;
  onError: (err: Error) => void;
};

export async function startPipeline(
  options: PipelineOptions,
): Promise<PipelineHandle> {
  const { track, codec, width, height, source, onError } = options;
  const id = `${source}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const meta: SessionMeta = {
    id,
    startedAt: Date.now(),
    status: "recording",
    codec,
    width,
    height,
    source,
  };
  const session = await openSession(meta);

  const inputFps = new RollingAverage(2000);
  const bitrate = new RollingAverage(2000);
  let queueDepth = 0;
  let bytesWritten = 0;
  let droppedFrames = 0;
  let stopped = false;
  let lastFrameTs = 0;

  const encoder = new VideoEncoder({
    output: async (chunk: EncodedVideoChunk) => {
      const view = new Uint8Array(chunk.byteLength);
      chunk.copyTo(view);
      bytesWritten += chunk.byteLength;
      bitrate.push(chunk.byteLength * 8); // bits
      try {
        await appendChunk(
          session,
          view.buffer,
          chunk.timestamp,
          chunk.duration ?? 0,
          chunk.type === "key",
        );
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    error: (err: DOMException) => {
      onError(err);
    },
  });

  encoder.configure({
    codec,
    width,
    height,
    bitrate: options.bitrate ?? 6_000_000,
    framerate: 30,
    latencyMode: "realtime",
  });

  // MediaStreamTrackProcessor — Chromium-only as of 2026.
  const processor = new (window as unknown as {
    MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>;
    };
  }).MediaStreamTrackProcessor({ track });

  let frameCounter = 0;
  const reader = processor.readable.getReader();

  void (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        const frame = value;
        // Drop frames if the encoder queue is too deep.
        if (encoder.encodeQueueSize > 30) {
          frame.close();
          droppedFrames += 1;
          continue;
        }
        // Only count frames we actually encode, so inputFps doesn't
        // over-report when frames are dropped.
        inputFps.push(1);
        frameCounter += 1;
        const keyFrame = frameCounter % 60 === 0;
        lastFrameTs = frame.timestamp;
        queueDepth = encoder.encodeQueueSize;
        try {
          encoder.encode(frame, { keyFrame });
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          frame.close();
        }
      }
    } finally {
      // Always release the reader so start/stop cycles don't leak it,
      // even if read()/encode() throws mid-loop. cancel() is idempotent.
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  })().catch((err: unknown) => {
    onError(err instanceof Error ? err : new Error(String(err)));
  });

  // Track may be ended externally (screen-share "stop sharing" UI).
  const onEnded = () => {
    void stop();
  };
  track.addEventListener("ended", onEnded);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    track.removeEventListener("ended", onEnded);
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    try {
      await encoder.flush();
    } catch {
      // ignore
    }
    try {
      encoder.close();
    } catch {
      // ignore
    }
    try {
      track.stop();
    } catch {
      // ignore
    }
    await closeSession(session, "complete");
    void lastFrameTs;
  };

  return {
    stop,
    getStats: () => ({
      inputFps: inputFps.rate(),
      encodeQueueSize: queueDepth,
      bitrateKbps: bitrate.rate() / 1000,
      bytesWritten,
      droppedFrames,
    }),
    getSession: () => session,
  };
}
