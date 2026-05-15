/// <reference lib="webworker" />
/**
 * Busy-loop worker for exp-27. Burns a CPU core for the requested
 * duration. Uses tight arithmetic + a tiny inner Atomics.wait with
 * 0 ms timeout (which is effectively a hot spin but lets the JS
 * engine know we're sync-busy).
 */

type RequestMessage = { durationMs: number };

const ab = new SharedArrayBuffer(4);
const view = new Int32Array(ab);

self.onmessage = (e: MessageEvent<RequestMessage>) => {
  const end = performance.now() + e.data.durationMs;
  let x = 0;
  while (performance.now() < end) {
    // Tight arithmetic loop — the JS engine cannot optimise this away
    // because `view` is shared and `x` escapes via the final post.
    for (let i = 0; i < 1_000_000; i += 1) {
      x = (x + Math.sqrt(i + 1)) | 0;
    }
    Atomics.add(view, 0, x & 0xff);
  }
  (self as DedicatedWorkerGlobalScope).postMessage({ done: true, x });
};

export {};
