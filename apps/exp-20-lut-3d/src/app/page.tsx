"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildIdentityLUT,
  buildWarmLUT,
  parseCube,
  type ParsedLUT,
} from "../lib/cube";
import { initGpu, uploadLutTexture, type LutGpu } from "../lib/gpu";
import { FULLSCREEN_VS, LUT_FS } from "../lib/shaders";

type ActiveLUT =
  | { kind: "identity" }
  | { kind: "warm" }
  | { kind: "user"; name: string };

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gpuRef = useRef<LutGpu | null>(null);
  const lutTexRef = useRef<GPUTexture | null>(null);
  const bindGroupRef = useRef<GPUBindGroup | null>(null);
  const renderFnRef = useRef<() => void>(() => {});
  const rafRef = useRef<number | null>(null);

  const [strength, setStrength] = useState(1.0);
  const [applyInLinear, setApplyInLinear] = useState(true);
  const [activeLUT, setActiveLUT] = useState<ActiveLUT>({ kind: "warm" });
  const [lutInfo, setLutInfo] = useState<{
    size: number;
    title: string | null;
    domainMin: [number, number, number];
    domainMax: [number, number, number];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const installLut = useCallback((lut: ParsedLUT) => {
    const gpu = gpuRef.current;
    if (!gpu) return;
    if (lutTexRef.current) {
      lutTexRef.current.destroy();
      lutTexRef.current = null;
    }
    const tex = uploadLutTexture(gpu.device, lut.size, lut.data);
    lutTexRef.current = tex;
    bindGroupRef.current = gpu.device.createBindGroup({
      layout: gpu.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tex.createView({ dimension: "3d" }) },
        { binding: 1, resource: gpu.sampler },
        { binding: 2, resource: { buffer: gpu.paramsBuffer } },
      ],
    });
    setLutInfo({
      size: lut.size,
      title: lut.title,
      domainMin: lut.domainMin,
      domainMax: lut.domainMax,
    });
  }, []);

  // GPU init once. Cleanup destroys textures and cancels rAF.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const gpu = await initGpu(canvas, FULLSCREEN_VS, LUT_FS);
        if (cancelled) {
          gpu.paramsBuffer.destroy();
          return;
        }
        gpuRef.current = gpu;
        installLut(buildWarmLUT(33));
        // Kick the render loop. We don't actually animate, but the params
        // buffer changes when sliders move and we want to re-blit on resize.
        const tick = () => {
          renderFnRef.current();
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (lutTexRef.current) lutTexRef.current.destroy();
      lutTexRef.current = null;
      if (gpuRef.current) {
        gpuRef.current.paramsBuffer.destroy();
        gpuRef.current.device.destroy();
      }
      gpuRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderOnce = useCallback(() => {
    const gpu = gpuRef.current;
    const bind = bindGroupRef.current;
    if (!gpu || !bind || !lutInfo) return;
    const [dminR, dminG, dminB] = lutInfo.domainMin;
    const [dmaxR, dmaxG, dmaxB] = lutInfo.domainMax;
    const params = new Float32Array([
      // vec4: scalars
      strength,
      applyInLinear ? 1.0 : 0.0,
      lutInfo.size,
      0,
      // vec4: domainMin (xyz, w pad)
      dminR,
      dminG,
      dminB,
      0,
      // vec4: domainMax (xyz, w pad)
      dmaxR,
      dmaxG,
      dmaxB,
      0,
    ]);
    gpu.device.queue.writeBuffer(gpu.paramsBuffer, 0, params.buffer);
    const encoder = gpu.device.createCommandEncoder();
    const view = gpu.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(gpu.pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
  }, [strength, applyInLinear, lutInfo]);

  // Sync the rAF loop's view of renderOnce so slider edits land next frame.
  useEffect(() => {
    renderFnRef.current = renderOnce;
  }, [renderOnce]);

  const onFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const lut = parseCube(text);
        installLut(lut);
        setActiveLUT({ kind: "user", name: file.name });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [installLut],
  );

  const pickBuiltin = useCallback(
    (which: "identity" | "warm", size: number) => {
      const lut = which === "identity" ? buildIdentityLUT(size) : buildWarmLUT(size);
      installLut(lut);
      setActiveLUT({ kind: which });
    },
    [installLut],
  );

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-20 · 3D LUT Sampling</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Loads a <code>.cube</code> LUT into a WebGPU{" "}
            <code>texture_3d&lt;f32&gt;</code>, samples it with trilinear
            filtering, and applies the result to a procedural reference ramp.
            Split-screen: source on the left, graded on the right.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <div className="relative aspect-[2/1] w-full overflow-hidden rounded border border-zinc-300 dark:border-zinc-700">
          <canvas
            ref={canvasRef}
            width={1024}
            height={512}
            className="block h-full w-full"
          />
        </div>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Source</h2>
            <div className="flex flex-col gap-2 text-xs">
              <button
                type="button"
                onClick={() => pickBuiltin("identity", 17)}
                className="rounded bg-zinc-900 px-2 py-1 text-white dark:bg-zinc-100 dark:text-black"
              >
                Built-in identity (17)
              </button>
              <button
                type="button"
                onClick={() => pickBuiltin("warm", 33)}
                className="rounded bg-zinc-900 px-2 py-1 text-white dark:bg-zinc-100 dark:text-black"
              >
                Built-in warm (33)
              </button>
              <label className="rounded border border-zinc-400 px-2 py-1 text-center cursor-pointer">
                Load .cube file
                <input
                  type="file"
                  accept=".cube,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    if (f) void onFile(f);
                  }}
                />
              </label>
            </div>
            <p className="mt-2 text-[10px] text-zinc-500">
              Active: {activeLUT.kind === "user" ? activeLUT.name : activeLUT.kind}
            </p>
          </div>

          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Parameters</h2>
            <div className="space-y-3 text-xs">
              <label className="block">
                <span className="text-zinc-500">strength: {strength.toFixed(2)}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={strength}
                  onChange={(e) => setStrength(parseFloat(e.target.value))}
                  className="block w-full"
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={applyInLinear}
                  onChange={(e) => setApplyInLinear(e.currentTarget.checked)}
                />
                <span>
                  Apply in linear (decode sRGB → sample → encode)
                </span>
              </label>
            </div>
          </div>

          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">LUT info</h2>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
              <dt className="text-zinc-500">title</dt>
              <dd className="truncate">{lutInfo?.title ?? "—"}</dd>
              <dt className="text-zinc-500">size</dt>
              <dd>{lutInfo ? `${lutInfo.size}³` : "—"}</dd>
              <dt className="text-zinc-500">domain min</dt>
              <dd>
                {lutInfo
                  ? `${lutInfo.domainMin[0]}, ${lutInfo.domainMin[1]}, ${lutInfo.domainMin[2]}`
                  : "—"}
              </dd>
              <dt className="text-zinc-500">domain max</dt>
              <dd>
                {lutInfo
                  ? `${lutInfo.domainMax[0]}, ${lutInfo.domainMax[1]}, ${lutInfo.domainMax[2]}`
                  : "—"}
              </dd>
              <dt className="text-zinc-500">ΔE76 vs ref</dt>
              <dd className="text-zinc-500">not computed (see exp-13)</dd>
            </dl>
          </div>
        </section>

        <footer className="text-xs text-zinc-500">
          The procedural ramp is generated in WGSL: top band sweeps hue,
          second band is greyscale, third band is red, bottom band splits
          green / blue. Toggle &quot;apply in linear&quot; to see the
          double-gamma failure mode on the warm LUT.
        </footer>
      </div>
    </main>
  );
}
