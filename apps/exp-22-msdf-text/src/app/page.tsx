"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildAtlas,
  layoutString,
  type Atlas,
  type LaidGlyph,
} from "../lib/atlas";
import { initGpu, uploadAtlasTexture, type TextGpu } from "../lib/gpu";

const FONT_FAMILY = "Inter";
const FONT_URL =
  "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.woff2";
const TITLE = "ReelForge Titles";

type Stats = { atlasMs: number; verts: number; frameMs: number | null };

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const atlasCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const gpuRef = useRef<TextGpu | null>(null);
  const atlasTexRef = useRef<GPUTexture | null>(null);
  const textBindRef = useRef<GPUBindGroup | null>(null);
  const atlasBindRef = useRef<GPUBindGroup | null>(null);
  const instanceBufferRef = useRef<GPUBuffer | null>(null);
  const instanceCountRef = useRef(0);
  const renderFnRef = useRef<() => void>(() => {});
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(performance.now());

  const [scale, setScale] = useState(1.0);    // 1.0 = 100%, up to 20.0 = 2000%
  const [rotateOn, setRotateOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>({ atlasMs: 0, verts: 0, frameMs: null });
  const [atlasReady, setAtlasReady] = useState(false);

  // Build atlas + initialise GPU once.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const gpu = await initGpu(canvas);
        if (cancelled) {
          gpu.device.destroy();
          return;
        }
        gpuRef.current = gpu;

        // Load the font *before* rasterising the atlas. FontFace.load()
        // alone does not guarantee the platform raster is hot — we then
        // also await `document.fonts.ready` inside buildAtlas.
        const face = new FontFace(FONT_FAMILY, `url(${FONT_URL})`);
        await face.load();
        document.fonts.add(face);

        const t0 = performance.now();
        const atlas = await buildAtlas({
          fontFamily: FONT_FAMILY,
          cellPx: 64,
          searchRadius: 8,
        });
        const atlasMs = performance.now() - t0;
        if (cancelled) return;

        installAtlas(atlas);
        renderAtlasPreview(atlas);
        setAtlasReady(true);
        setStats((s) => ({ ...s, atlasMs }));

        const loop = () => {
          renderFnRef.current();
          rafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (instanceBufferRef.current) instanceBufferRef.current.destroy();
      if (atlasTexRef.current) atlasTexRef.current.destroy();
      atlasTexRef.current = null;
      instanceBufferRef.current = null;
      if (gpuRef.current) {
        gpuRef.current.uniformBuffer.destroy();
        gpuRef.current.device.destroy();
      }
      gpuRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installAtlas = useCallback((atlas: Atlas) => {
    const gpu = gpuRef.current;
    if (!gpu) return;

    if (atlasTexRef.current) atlasTexRef.current.destroy();
    const tex = uploadAtlasTexture(gpu.device, atlas.width, atlas.height, atlas.pixels);
    atlasTexRef.current = tex;

    // Lay out the title once. We'll pre-fill an instance buffer with the
    // glyph quads — only the affine matrix in the uniform changes per
    // frame, so the atlas + instance buffer stay hot.
    const baselinePx = 200;
    const { glyphs, widthPx } = layoutString(atlas, TITLE, baselinePx);
    const instances = packInstances(glyphs, -widthPx / 2);

    if (instanceBufferRef.current) instanceBufferRef.current.destroy();
    const ib = gpu.device.createBuffer({
      size: Math.max(64, instances.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    gpu.device.queue.writeBuffer(ib, 0, instances.buffer);
    instanceBufferRef.current = ib;
    instanceCountRef.current = glyphs.length;

    textBindRef.current = gpu.device.createBindGroup({
      layout: gpu.textPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: gpu.uniformBuffer } },
        { binding: 1, resource: tex.createView() },
        { binding: 2, resource: gpu.sampler },
      ],
    });
    atlasBindRef.current = gpu.device.createBindGroup({
      layout: gpu.atlasPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: gpu.sampler },
      ],
    });

    setStats((s) => ({ ...s, verts: glyphs.length * 6 }));
  }, []);

  const renderFrame = useCallback(() => {
    const gpu = gpuRef.current;
    const bind = textBindRef.current;
    const ib = instanceBufferRef.current;
    if (!gpu || !bind || !ib) return;

    const t0 = performance.now();
    const canvas = canvasRef.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const wantW = Math.floor(canvas.clientWidth * dpr);
    const wantH = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }

    // Build a 2x3 affine: scale + rotation about the canvas centre.
    const angle = rotateOn ? ((performance.now() - startRef.current) / 1500) % (Math.PI * 2) : 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const a = cos * scale;
    const b = sin * scale;
    const c = -sin * scale;
    const d = cos * scale;
    const tx = canvas.width / 2;
    const ty = canvas.height / 2;
    const uniforms = new Float32Array([
      a, c, tx, b,                       // m0
      d, ty, 0, 0,                       // m1
      canvas.width, canvas.height, 0, 0, // viewport
    ]);
    gpu.device.queue.writeBuffer(gpu.uniformBuffer, 0, uniforms.buffer);

    const encoder = gpu.device.createCommandEncoder();
    const view = gpu.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0.05, g: 0.08, b: 0.12, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(gpu.textPipeline);
    pass.setBindGroup(0, bind);
    pass.setVertexBuffer(0, ib);
    // 6 vertices per instance, one instance per glyph.
    pass.draw(6, instanceCountRef.current, 0, 0);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);

    const frameMs = performance.now() - t0;
    // Throttle setState to ~10 Hz so React doesn't dominate the trace.
    if (Math.random() < 0.1) {
      setStats((s) => ({ ...s, frameMs }));
    }
  }, [scale, rotateOn]);

  // Keep the rAF loop's view of renderFrame current so slider changes take
  // effect on the next frame without restarting the loop.
  useEffect(() => {
    renderFnRef.current = renderFrame;
  }, [renderFrame]);

  // Render the SDF atlas to a plain 2D canvas as the debug view. We re-use
  // a small offscreen path instead of a second WebGPU surface to keep the
  // experiment focused.
  const renderAtlasPreview = useCallback((atlas: Atlas) => {
    const cv = atlasCanvasRef.current;
    if (!cv) return;
    cv.width = atlas.width;
    cv.height = atlas.height;
    const c = cv.getContext("2d");
    if (!c) return;
    const img = c.createImageData(atlas.width, atlas.height);
    for (let i = 0; i < atlas.pixels.length; i++) {
      const v = atlas.pixels[i];
      img.data[i * 4 + 0] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }, []);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-22 · GPU Text (SDF)</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Bakes a 1-channel SDF atlas from <code>{FONT_FAMILY}</code> at
            startup (CPU brute-force, slow but correct) and renders a title
            in WGSL using <code>fwidth</code>-based anti-aliasing. Scale to
            2000% and rotate — edges stay crisp because the atlas is
            sampled, not re-rasterised.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <div className="relative aspect-[2/1] w-full overflow-hidden rounded border border-zinc-300 dark:border-zinc-700">
          <canvas ref={canvasRef} className="block h-full w-full" />
          {!atlasReady && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/60 text-xs text-zinc-200">
              baking SDF atlas...
            </div>
          )}
        </div>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Transform</h2>
            <label className="block text-xs">
              <span className="text-zinc-500">
                scale: {(scale * 100).toFixed(0)}%
              </span>
              <input
                type="range"
                min={1}
                max={20}
                step={0.05}
                value={scale}
                onChange={(e) => setScale(parseFloat(e.target.value))}
                className="block w-full"
              />
            </label>
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={rotateOn}
                onChange={(e) => setRotateOn(e.currentTarget.checked)}
              />
              <span>rotate</span>
            </label>
          </div>

          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Stats</h2>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
              <dt className="text-zinc-500">atlas bake</dt>
              <dd>{stats.atlasMs.toFixed(0)} ms</dd>
              <dt className="text-zinc-500">vertices</dt>
              <dd>{stats.verts}</dd>
              <dt className="text-zinc-500">last frame</dt>
              <dd>{stats.frameMs?.toFixed(2) ?? "—"} ms</dd>
              <dt className="text-zinc-500">channels</dt>
              <dd>1 (SDF, not true MSDF)</dd>
            </dl>
          </div>

          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">SDF atlas</h2>
            <div className="overflow-hidden rounded bg-zinc-900 p-1">
              <canvas
                ref={atlasCanvasRef}
                className="block h-full w-full"
                style={{ imageRendering: "pixelated" }}
              />
            </div>
          </div>
        </section>

        <footer className="text-xs text-zinc-500">
          RTL + complex shaping (CJK, Arabic, Devanagari) is out of scope.
          The bake step uses CPU brute force (O(n²·r²)) — fine at startup,
          not viable per-frame. Production should use a jump-flooding
          shader or a prebuilt MSDF atlas (`msdf-atlas-gen`).
        </footer>
      </div>
    </main>
  );
}

/** Pack laid-out glyphs into instance vertex data: 8 floats per quad. */
function packInstances(glyphs: LaidGlyph[], originXPx: number): Float32Array {
  const out = new Float32Array(glyphs.length * 8);
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    out[i * 8 + 0] = g.x0 + originXPx;
    out[i * 8 + 1] = g.y0;
    out[i * 8 + 2] = g.x1 + originXPx;
    out[i * 8 + 3] = g.y1;
    out[i * 8 + 4] = g.u0;
    out[i * 8 + 5] = g.v0;
    out[i * 8 + 6] = g.u1;
    out[i * 8 + 7] = g.v1;
  }
  return out;
}
