/// <reference lib="webworker" />

import { ort, fetchModelCached, createSession } from "@reelforge/onnx";

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
  const { bytes, fromCache } = await fetchModelCached(url);
  self.postMessage({
    type: "STATUS",
    message: fromCache ? "model from Cache API" : "downloaded model",
  });
  await mountSession(bytes);
}

async function loadFromBytes(bytes: ArrayBuffer): Promise<void> {
  await mountSession(bytes);
}

async function mountSession(modelBytes: ArrayBuffer): Promise<void> {
  const loaded = await createSession(modelBytes);
  session = loaded.session;
  inputName = loaded.inputNames[0];
  self.postMessage({
    type: "READY",
    provider: loaded.provider,
    inputs: loaded.inputNames,
    outputs: loaded.outputNames,
    message: loaded.warning ? `WebGPU EP unavailable: ${loaded.warning}` : undefined,
  });
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
