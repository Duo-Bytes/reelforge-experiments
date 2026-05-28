/// <reference lib="webworker" />

import { ort, loadOnnxFromUrl } from "@reelforge/onnx";

type LoadMsg = { type: "LOAD"; url: string };
type RunMsg = {
  type: "RUN";
  samples: Float32Array;
  sampleRate: number;
  hop: number;
};
type InMsg = LoadMsg | RunMsg;

let session: ort.InferenceSession | null = null;
let provider: "webgpu" | "wasm" | null = null;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "LOAD") {
      await load(e.data.url);
    } else if (e.data.type === "RUN") {
      await run(e.data.samples, e.data.sampleRate, e.data.hop);
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function load(url: string): Promise<void> {
  self.postMessage({ type: "STATUS", message: "fetching model…" });
  const loaded = await loadOnnxFromUrl(url);
  session = loaded.session;
  provider = loaded.provider;
  if (loaded.warning) {
    self.postMessage({
      type: "STATUS",
      message: `WebGPU EP unavailable, using wasm: ${loaded.warning}`,
    });
  }
  self.postMessage({
    type: "READY",
    provider,
    inputs: loaded.inputNames,
    outputs: loaded.outputNames,
  });
}

async function run(
  samples: Float32Array,
  sampleRate: number,
  hop: number,
): Promise<void> {
  if (!session) throw new Error("session not loaded");
  if (sampleRate !== 16000 && sampleRate !== 8000) {
    throw new Error(`silero-vad expects 16k or 8k, got ${sampleRate}`);
  }

  const t0 = performance.now();
  const numHops = Math.floor(samples.length / hop);
  const probs = new Float32Array(numHops);

  // Silero-VAD v5 takes a stateful LSTM hidden of shape [2, 1, 128].
  let state = new Float32Array(2 * 1 * 128);
  const srTensor = new ort.Tensor(
    "int64",
    BigInt64Array.from([BigInt(sampleRate)]),
    [1],
  );
  const inputName = session.inputNames[0];
  const stateName = session.inputNames.includes("state") ? "state" : "h";
  const srName = session.inputNames.includes("sr") ? "sr" : "sampling_rate";

  for (let i = 0; i < numHops; i++) {
    const chunk = samples.subarray(i * hop, i * hop + hop);
    // Tensor expects a fresh, contiguous buffer.
    const chunkCopy = new Float32Array(chunk);
    const input = new ort.Tensor("float32", chunkCopy, [1, hop]);
    const stateTensor = new ort.Tensor("float32", state, [2, 1, 128]);

    const feeds: Record<string, ort.Tensor> = {
      [inputName]: input,
      [stateName]: stateTensor,
      [srName]: srTensor,
    };

    const results = await session.run(feeds);
    const outName = session.outputNames[0];
    const stateOutName = session.outputNames.includes("stateN")
      ? "stateN"
      : session.outputNames[1];
    probs[i] = (results[outName].data as Float32Array)[0];
    state = new Float32Array(results[stateOutName].data as Float32Array);

    input.dispose?.();
    stateTensor.dispose?.();
    for (const k of Object.keys(results)) results[k].dispose?.();

    // Stream progress every ~50 hops so the UI can show a bar.
    if ((i & 0x3f) === 0) {
      self.postMessage({
        type: "PROGRESS",
        done: i,
        total: numHops,
      });
    }
  }

  srTensor.dispose?.();

  self.postMessage(
    {
      type: "PROBS",
      probs,
      hop,
      sampleRate,
      totalMs: performance.now() - t0,
      provider,
    },
    [probs.buffer],
  );
}
