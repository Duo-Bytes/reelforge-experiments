/// <reference lib="webworker" />
/**
 * Subject-detection worker for exp-34 auto-reframe.
 *
 * Runs YOLOS-tiny object detection via Transformers.js (onnxruntime-web)
 * on the WebGPU EP, wasm fallback. The main thread samples a downscaled
 * frame every ~150 ms and sends RGBA pixels here; we return the best
 * subject box (prefer "person") in normalised [0,1] coords. The rAF loop
 * does Catmull-Rom smoothing + cropping. Frames never leave the machine;
 * only model weights download (once, then cached).
 */

import {
  pipeline,
  env,
  RawImage,
  type DeviceType,
  type ObjectDetectionPipeline,
} from "@huggingface/transformers";

env.allowLocalModels = false;

const REPO = "Xenova/yolos-tiny";

type DetectMsg = {
  type: "DETECT";
  id: number;
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
};

type Box = { score: number; label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } };

const createDetector = pipeline as unknown as (
  task: "object-detection",
  model: string,
  options: Record<string, unknown>,
) => Promise<ObjectDetectionPipeline>;

let detector: ObjectDetectionPipeline | null = null;
let loading: Promise<ObjectDetectionPipeline> | null = null;

type Provider = Extract<DeviceType, "webgpu" | "wasm">;

function createOnDevice(device: Provider): Promise<ObjectDetectionPipeline> {
  return createDetector("object-detection", REPO, {
    device,
    dtype: "fp32",
    progress_callback: (p: unknown) => {
      const e = p as { status?: string; progress?: number };
      if (e.status === "progress" && typeof e.progress === "number") {
        self.postMessage({ type: "LOAD", done: Math.round(e.progress) });
      }
    },
  });
}

async function getDetector(): Promise<ObjectDetectionPipeline> {
  if (detector) return detector;
  if (!loading) {
    // Prefer the WebGPU EP; transparently fall back to wasm if WebGPU is
    // unavailable (no navigator.gpu, unsupported browser, adapter failure).
    // The promise has a catch path so a missing GPU degrades instead of
    // leaving the worker stuck with an unhandled rejection.
    loading = (async (): Promise<ObjectDetectionPipeline> => {
      let provider: Provider = "webgpu";
      let d: ObjectDetectionPipeline;
      try {
        d = await createOnDevice("webgpu");
      } catch (err) {
        provider = "wasm";
        self.postMessage({
          type: "FALLBACK",
          provider,
          message: err instanceof Error ? err.message : String(err),
        });
        d = await createOnDevice("wasm");
      }
      detector = d;
      self.postMessage({ type: "READY", provider });
      return d;
    })().catch((err) => {
      // Both providers failed; reset so a later message can retry, and
      // surface the error to the main thread.
      loading = null;
      self.postMessage({
        type: "ERROR",
        id: -1,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });
  }
  return loading;
}

// Avoid queueing: drop DETECT messages while one is in flight.
let busy = false;

self.onmessage = async (e: MessageEvent<DetectMsg>) => {
  if (e.data.type !== "DETECT") return;
  const { id, width, height, data } = e.data;
  if (busy) {
    self.postMessage({ type: "BUSY", id });
    return;
  }
  busy = true;
  try {
    const pipe = await getDetector();
    // RGBA → RGB for the model.
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    const image = new RawImage(rgb, width, height, 3);

    const detect = pipe as unknown as (
      img: RawImage,
      options: Record<string, unknown>,
    ) => Promise<Box[]>;
    const results = await detect(image, { threshold: 0.3, percentage: true });

    // Prefer the highest-confidence person; else the highest-confidence box.
    let best: Box | null = null;
    for (const r of results) {
      const isPerson = r.label === "person";
      if (!best) best = r;
      else {
        const bestPerson = best.label === "person";
        if (isPerson && !bestPerson) best = r;
        else if (isPerson === bestPerson && r.score > best.score) best = r;
      }
    }

    if (best) {
      // `percentage: true` gives box coords already in [0,1].
      const b = best.box;
      self.postMessage({
        type: "FOCUS",
        id,
        cx: (b.xmin + b.xmax) / 2,
        cy: (b.ymin + b.ymax) / 2,
        w: Math.max(0, b.xmax - b.xmin),
        h: Math.max(0, b.ymax - b.ymin),
        label: best.label,
        score: best.score,
      });
    } else {
      self.postMessage({ type: "NOFOCUS", id });
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    busy = false;
  }
};

// Begin downloading + initialising the model as soon as the worker spins
// up, so the UI can flip to "ready" before the first frame is sampled. The
// rejection (if both EPs fail) is already reported to the main thread inside
// getDetector, so swallow it here to avoid an unhandledrejection.
getDetector().catch(() => {});

export {};
