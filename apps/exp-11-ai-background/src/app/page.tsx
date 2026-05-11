"use client";

import { useEffect, useRef, useState } from "react";
import { MASK_WGSL } from "../shaders/mask.wgsl";

type Ready = {
  provider: string;
  inputs: string[];
  outputs: string[];
  message?: string;
};

type MaskResult = {
  width: number;
  height: number;
  mask: Uint8Array;
  inferenceMs: number;
  totalMs: number;
};

const DEFAULT_MODEL_URL =
  "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx";
const INPUT_SIZE = 1024;

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState("idle");
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageBitmap, setImageBitmap] = useState<ImageBitmap | null>(null);
  const [maskResult, setMaskResult] = useState<MaskResult | null>(null);
  const [showMaskOnly, setShowMaskOnly] = useState(false);
  const [bgColor, setBgColor] = useState("#10b981");
  const [busy, setBusy] = useState(false);
  const [modelUrl, setModelUrl] = useState(DEFAULT_MODEL_URL);
  const [inferences, setInferences] = useState<MaskResult[]>([]);

  // GPU pipeline state
  const gpuRef = useRef<{
    device: GPUDevice;
    context: GPUCanvasContext;
    pipeline: GPURenderPipeline;
    sampler: GPUSampler;
    uniformBuffer: GPUBuffer;
  } | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/ai.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "STATUS") {
        setStatus(m.message);
      } else if (m.type === "READY") {
        setReady({
          provider: m.provider,
          inputs: m.inputs,
          outputs: m.outputs,
          message: m.message,
        });
        setStatus(`session ready · ${m.provider}`);
        setBusy(false);
      } else if (m.type === "MASK") {
        const r: MaskResult = {
          width: m.width,
          height: m.height,
          mask: m.mask,
          inferenceMs: m.inferenceMs,
          totalMs: m.totalMs,
        };
        setMaskResult(r);
        setInferences((arr) => [...arr.slice(-19), r]);
        setBusy(false);
        setStatus(
          `inferred ${m.width}x${m.height} in ${m.inferenceMs.toFixed(0)} ms`,
        );
      } else if (m.type === "ERROR") {
        setError(m.message);
        setBusy(false);
      }
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  // Render whenever the bitmap or mask changes.
  useEffect(() => {
    void renderComposite();
  }, [imageBitmap, maskResult, showMaskOnly, bgColor]);

  async function ensureGPU() {
    if (gpuRef.current) return gpuRef.current;
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("canvas missing");
    if (!navigator.gpu) throw new Error("WebGPU unavailable");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("no GPU adapter");
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("no webgpu canvas context");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "premultiplied" });
    const shader = device.createShaderModule({ code: MASK_WGSL });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
    const sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    const uniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    gpuRef.current = { device, context, pipeline, sampler, uniformBuffer };
    return gpuRef.current;
  }

  async function renderComposite(): Promise<void> {
    if (!imageBitmap) return;
    try {
      const gpu = await ensureGPU();
      const canvas = canvasRef.current!;
      canvas.width = imageBitmap.width;
      canvas.height = imageBitmap.height;

      // Source texture from imageBitmap
      const srcTex = gpu.device.createTexture({
        size: [imageBitmap.width, imageBitmap.height, 1],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      gpu.device.queue.copyExternalImageToTexture(
        { source: imageBitmap },
        { texture: srcTex },
        [imageBitmap.width, imageBitmap.height],
      );

      // Mask texture: from current maskResult (single-channel R) or 1x1 white
      let maskTex: GPUTexture;
      let useMask = 1;
      if (maskResult) {
        const rgba = new Uint8Array(maskResult.width * maskResult.height * 4);
        for (let i = 0; i < maskResult.mask.length; i++) {
          rgba[i * 4 + 0] = maskResult.mask[i];
          rgba[i * 4 + 1] = 0;
          rgba[i * 4 + 2] = 0;
          rgba[i * 4 + 3] = 255;
        }
        maskTex = gpu.device.createTexture({
          size: [maskResult.width, maskResult.height, 1],
          format: "rgba8unorm",
          usage:
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        gpu.device.queue.writeTexture(
          { texture: maskTex },
          rgba,
          { bytesPerRow: maskResult.width * 4 },
          [maskResult.width, maskResult.height],
        );
      } else {
        // 1x1 white mask = pure passthrough
        maskTex = gpu.device.createTexture({
          size: [1, 1, 1],
          format: "rgba8unorm",
          usage:
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        gpu.device.queue.writeTexture(
          { texture: maskTex },
          new Uint8Array([255, 0, 0, 255]),
          { bytesPerRow: 4 },
          [1, 1],
        );
        useMask = 0;
      }

      // Uniforms
      const [r, g, b] = hexToRgb(bgColor);
      const u = new Float32Array(8);
      u[0] = r;
      u[1] = g;
      u[2] = b;
      u[3] = 1;
      u[4] = useMask;
      u[5] = showMaskOnly ? 1 : 0;
      gpu.device.queue.writeBuffer(gpu.uniformBuffer, 0, u);

      const bindGroup = gpu.device.createBindGroup({
        layout: gpu.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: gpu.sampler },
          { binding: 1, resource: srcTex.createView() },
          { binding: 2, resource: maskTex.createView() },
          { binding: 3, resource: { buffer: gpu.uniformBuffer } },
        ],
      });

      const enc = gpu.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: gpu.context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(gpu.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
      gpu.device.queue.submit([enc.finish()]);

      // Free transient textures (kept simple — destroy after submit)
      srcTex.destroy();
      maskTex.destroy();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const onLoadFromUrl = () => {
    setBusy(true);
    setStatus("loading model...");
    workerRef.current?.postMessage({ type: "LOAD_URL", url: modelUrl });
  };

  const onModelFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setStatus("loading model bytes...");
    const buf = await file.arrayBuffer();
    workerRef.current?.postMessage({ type: "LOAD_BYTES", bytes: buf }, [
      buf,
    ]);
  };

  const onImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bm = await createImageBitmap(file);
    setImageBitmap(bm);
    setMaskResult(null);
  };

  const runSegment = async () => {
    if (!ready) {
      setError("load model first");
      return;
    }
    if (!imageBitmap) {
      setError("pick an image first");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("segmenting...");
    // Clone the bitmap for the worker — original stays here for re-rendering
    const bm = await createImageBitmap(imageBitmap);
    workerRef.current?.postMessage(
      {
        type: "SEGMENT",
        bitmap: bm,
        inputSize: INPUT_SIZE,
        inputName: ready.inputs[0],
      },
      [bm],
    );
  };

  const median = (xs: number[]) =>
    xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;

  const inferStats =
    inferences.length === 0
      ? null
      : {
          count: inferences.length,
          medianInferenceMs: median(inferences.map((r) => r.inferenceMs)),
          medianTotalMs: median(inferences.map((r) => r.totalMs)),
        };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-11 · AI Background Removal</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            ONNX Runtime Web (WebGPU EP) runs a segmentation model on the
            local GPU. Mask uploads as `texture_2d&lt;f32&gt;` to the WebGPU
            compositor, fragment shader applies it as soft alpha.
          </p>
          <p className="text-xs text-zinc-500">
            Targets: model load &lt; 2s on 2nd visit (Cache API) · inference
            &lt; 100ms (WebGPU EP) · clean edges around hair.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Model</h2>
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex flex-1 items-center gap-2">
                URL
                <input
                  type="text"
                  value={modelUrl}
                  onChange={(e) => setModelUrl(e.target.value)}
                  className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <button
                type="button"
                onClick={onLoadFromUrl}
                disabled={busy}
                className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
              >
                load url
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span>or local file</span>
              <input
                type="file"
                accept=".onnx"
                onChange={onModelFile}
                disabled={busy}
                className="text-xs"
              />
            </div>
            <div className="text-zinc-500">{status}</div>
            {ready && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
                <dt className="text-zinc-500">provider</dt>
                <dd className="font-bold">{ready.provider}</dd>
                <dt className="text-zinc-500">inputs</dt>
                <dd className="font-mono">{ready.inputs.join(", ")}</dd>
                <dt className="text-zinc-500">outputs</dt>
                <dd className="font-mono">{ready.outputs.join(", ")}</dd>
                {ready.message && (
                  <>
                    <dt className="text-zinc-500">note</dt>
                    <dd className="text-amber-500">{ready.message}</dd>
                  </>
                )}
              </dl>
            )}
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Image</h2>
          <input
            type="file"
            accept="image/*"
            onChange={onImageFile}
            className="block w-full text-xs"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <button
              type="button"
              onClick={runSegment}
              disabled={busy || !ready || !imageBitmap}
              className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              run segmentation
            </button>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showMaskOnly}
                onChange={(e) => setShowMaskOnly(e.target.checked)}
              />
              show mask only
            </label>
            <label className="flex items-center gap-2">
              bg color
              <input
                type="color"
                value={bgColor}
                onChange={(e) => setBgColor(e.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Composite</h2>
          <canvas
            ref={canvasRef}
            className="aspect-video max-h-[60vh] w-full bg-zinc-900 object-contain"
          />
        </section>

        {maskResult && (
          <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
            <h3 className="mb-1 text-sm font-semibold">Last inference</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
              <dt className="text-zinc-500">mask</dt>
              <dd>
                {maskResult.width}×{maskResult.height}
              </dd>
              <dt className="text-zinc-500">inference</dt>
              <dd className="font-bold">
                {maskResult.inferenceMs.toFixed(1)} ms
              </dd>
              <dt className="text-zinc-500">total (incl. pre/post)</dt>
              <dd>{maskResult.totalMs.toFixed(1)} ms</dd>
            </dl>
            {inferStats && (
              <div className="mt-2 text-zinc-500">
                history n={inferStats.count} · median inference{" "}
                {inferStats.medianInferenceMs.toFixed(1)}ms · median total{" "}
                {inferStats.medianTotalMs.toFixed(1)}ms
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  return [r, g, b];
}
