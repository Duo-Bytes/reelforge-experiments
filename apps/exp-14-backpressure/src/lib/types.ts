export type CodecConfig = {
  codec: string;
  description: Uint8Array;
  width: number;
  height: number;
  fps: number;
};

export type VideoSample = {
  ptsUs: number;
  dtsUs: number;
  durationUs: number;
  offset: number;
  size: number;
  isKeyframe: boolean;
};

export type RunMode = "backpressure" | "no-backpressure";
export type CloseMode = "close" | "leak";

export type RunMetrics = {
  decodedCount: number;
  closedCount: number;
  outstandingFrames: number;
  peakQueueSize: number;
  currentQueueSize: number;
  avgDecodeIntervalMs: number;
  rollingFps: number;
  elapsedMs: number;
  jsHeapMb?: number;
};
