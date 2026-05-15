/// <reference lib="webworker" />
/**
 * Peak-build worker for exp-25.
 *
 * Receives a Float32Array (channel-0 PCM) via transfer, builds three LODs
 * (binSize 256/4096/65536), serialises to the peak file format and posts
 * back the resulting ArrayBuffer (also transferred).
 */

import { buildPeaks, serializePeaks } from "../lib/peak-format";

type RequestMessage = {
  id: number;
  buffer: ArrayBuffer;
  sampleRate: number;
};

type ResponseMessage = {
  id: number;
  result: ArrayBuffer;
  buildMs: number;
};

self.onmessage = (e: MessageEvent<RequestMessage>) => {
  const { id, buffer, sampleRate } = e.data;
  const channel = new Float32Array(buffer);
  const t0 = performance.now();
  const peaks = buildPeaks(channel, sampleRate);
  const serialized = serializePeaks(peaks);
  const buildMs = performance.now() - t0;
  const reply: ResponseMessage = { id, result: serialized, buildMs };
  (self as DedicatedWorkerGlobalScope).postMessage(reply, [serialized]);
};

export {};
