/// <reference lib="webworker" />

import * as ort from "onnxruntime-web/webgpu";

type LoadFromUrlMsg = { type: "LOAD_URL"; url: string };
type LoadFromBytesMsg = { type: "LOAD_BYTES"; bytes: ArrayBuffer };
type SegmentMsg = {
  type: "SEGMENT";
  bitmap: ImageBitmap;
  inputSize: number;
  inputName?: string;
};
type InMsg = LoadFromUrlMsg | LoadFromBytesMsg | SegmentMsg;

let session: ort.InferenceSession | null = null;
let inputName = "input";

const MODEL_CACHE = "reelforge-models-v1";

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "LOAD_URL") {
      await loadFromUrl(e.data.url);
    } else if (e.data.type === "LOAD_BYTES") {
      await loadFromBytes(e.data.bytes);
    } else if (e.data.type === "SEGMENT") {
      const inName = e.data.inputName ?? inputName;
      const result = await segment(e.data.bitmap, e.data.inputSize, inName);
      self.postMessage(
        {
          type: "MASK",
          width: result.width,
          height: result.height,
          mask: result.mask,
          inferenceMs: result.inferenceMs,
          totalMs: result.totalMs,
        },
        [result.mask.buffer],
      );
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function loadFromUrl(url: string): Promise<void> {
  self.postMessage({ type: "STATUS", message: "fetching model..." });
  const cache = await caches.open(MODEL_CACHE);
  let response = await cache.match(url);
  if (response) {
    self.postMessage({ type: "STATUS", message: "model from Cache API" });
  } else {
    self.postMessage({ type: "STATUS", message: "downloading model..." });
    const fetched = await fetch(url, { mode: "cors" });
    if (!fetched.ok) throw new Error(`fetch failed: ${fetched.status}`);
    await cache.put(url, fetched.clone());
    response = fetched;
  }
  const buf = await response.arrayBuffer();
  await createSession(buf);
}

async function loadFromBytes(bytes: ArrayBuffer): Promise<void> {
  await createSession(bytes);
}

async function createSession(modelBytes: ArrayBuffer): Promise<void> {
  // Set wasmPaths to a CDN so onnxruntime-web finds its WASM/WebGPU shims.
  ort.env.wasm.wasmPaths =
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/";
  // Try WebGPU EP first; fall back to WASM if unsupported.
  let providers: Array<"webgpu" | "wasm"> = ["webgpu", "wasm"];
  try {
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: providers,
      graphOptimizationLevel: "all",
    });
    self.postMessage({
      type: "READY",
      provider: providers[0],
      inputs: session.inputNames,
      outputs: session.outputNames,
    });
  } catch (err) {
    providers = ["wasm"];
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: providers,
      graphOptimizationLevel: "all",
    });
    self.postMessage({
      type: "READY",
      provider: "wasm",
      inputs: session.inputNames,
      outputs: session.outputNames,
      message:
        "WebGPU EP unavailable: " +
        (err instanceof Error ? err.message : String(err)),
    });
  }
  inputName = session.inputNames[0];
}

async function segment(
  bitmap: ImageBitmap,
  size: number,
  inName: string,
): Promise<{
  width: number;
  height: number;
  mask: Uint8Array;
  inferenceMs: number;
  totalMs: number;
}> {
  if (!session) throw new Error("session not loaded");
  const t0 = performance.now();

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0, size, size);
  const imageData = ctx.getImageData(0, 0, size, size);
  const rgba = imageData.data;

  const numPixels = size * size;
  const tensorData = new Float32Array(3 * numPixels);
  for (let i = 0; i < numPixels; i++) {
    tensorData[i] = rgba[i * 4 + 0] / 255;
    tensorData[numPixels + i] = rgba[i * 4 + 1] / 255;
    tensorData[2 * numPixels + i] = rgba[i * 4 + 2] / 255;
  }
  const inputTensor = new ort.Tensor("float32", tensorData, [
    1,
    3,
    size,
    size,
  ]);

  const tInfer = performance.now();
  const results = await session.run({ [inName]: inputTensor });
  const inferenceMs = performance.now() - tInfer;

  const outName = session.outputNames[0];
  const out = results[outName];
  // Many segmentation models output [1, 1, H, W] sigmoid activations or
  // [1, 2, H, W] argmax pairs. We assume [1, 1, H, W] for matting models.
  const data = out.data as Float32Array;
  const outDims = out.dims as readonly number[];
  const outH = outDims[outDims.length - 2];
  const outW = outDims[outDims.length - 1];
  const mask = new Uint8Array(outW * outH);
  for (let i = 0; i < mask.length; i++) {
    const v = data[i];
    mask[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }

  // Free output buffers explicitly when possible.
  for (const k of Object.keys(results)) {
    const t = results[k];
    if (typeof t.dispose === "function") t.dispose();
  }
  inputTensor.dispose?.();
  bitmap.close();

  return {
    width: outW,
    height: outH,
    mask,
    inferenceMs,
    totalMs: performance.now() - t0,
  };
}
