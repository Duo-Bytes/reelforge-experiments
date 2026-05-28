// Shared onnxruntime-web session loader for ReelForge experiments.
//
// Centralises the two things every ONNX worker repeats: the WASM/WebGPU
// shim path (pinned to the package's own ort version so the JS and binary
// halves never disagree) and the WebGPU-EP-first / wasm-fallback session
// creation. Also a Cache-API model fetch so weights download once.
//
// Re-exports `ort` so callers can build Tensors from the same module
// instance (env/config is process-global and shared).

import * as ort from "onnxruntime-web/webgpu";

export { ort };

const WASM_VERSION = "1.25.1";
let wasmConfigured = false;

function configureWasm(): void {
  if (wasmConfigured) return;
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${WASM_VERSION}/dist/`;
  wasmConfigured = true;
}

export type OnnxSession = {
  session: ort.InferenceSession;
  provider: "webgpu" | "wasm";
  inputNames: readonly string[];
  outputNames: readonly string[];
  /** Set when WebGPU EP was unavailable and we fell back to wasm. */
  warning?: string;
};

/** Create a session, preferring the WebGPU EP and falling back to wasm. */
export async function createSession(
  model: ArrayBuffer | Uint8Array,
): Promise<OnnxSession> {
  configureWasm();
  const bytes = model instanceof Uint8Array ? model : new Uint8Array(model);
  try {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
    });
    return {
      session,
      provider: "webgpu",
      inputNames: session.inputNames,
      outputNames: session.outputNames,
    };
  } catch (err) {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    return {
      session,
      provider: "wasm",
      inputNames: session.inputNames,
      outputNames: session.outputNames,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

const DEFAULT_CACHE = "reelforge-models-v1";

/** Fetch model bytes through the Cache API so they download only once. */
export async function fetchModelCached(
  url: string,
  cacheName: string = DEFAULT_CACHE,
): Promise<{ bytes: ArrayBuffer; fromCache: boolean }> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(url);
  if (hit) return { bytes: await hit.arrayBuffer(), fromCache: true };
  const fetched = await fetch(url, { mode: "cors" });
  if (!fetched.ok) throw new Error(`fetch ${url} → ${fetched.status}`);
  await cache.put(url, fetched.clone());
  return { bytes: await fetched.arrayBuffer(), fromCache: false };
}

/** Convenience: fetch (cached) then create a session. */
export async function loadOnnxFromUrl(
  url: string,
  cacheName: string = DEFAULT_CACHE,
): Promise<OnnxSession & { fromCache: boolean }> {
  const { bytes, fromCache } = await fetchModelCached(url, cacheName);
  const s = await createSession(bytes);
  return { ...s, fromCache };
}
