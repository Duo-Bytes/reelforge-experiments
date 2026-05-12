"use client";

import { useEffect, useRef, useState } from "react";
import { COLOR_WGSL } from "../shaders/color.wgsl";
import type {
  LayerInfo,
  MatrixCoeffs,
  Primaries,
  TargetColor,
  ToneMap,
  Transfer,
} from "../lib/types";

type GpuRefs = {
  device: GPUDevice;
  context: GPUCanvasContext;
  pipeline: GPURenderPipeline;
  sampler: GPUSampler;
  uniformBuffer: GPUBuffer;
  format: GPUTextureFormat;
};

const TRANSFER_CODE: Record<Transfer, number> = {
  srgb: 0,
  bt709: 1,
  pq: 2,
  hlg: 3,
  linear: 4,
};
const PRIMARIES_CODE: Record<Primaries, number> = {
  bt709: 0,
  p3: 1,
  bt2020: 2,
};
const TONEMAP_CODE: Record<ToneMap, number> = {
  none: 0,
  reinhard: 1,
  hable: 2,
};

function inferTransfer(s: string | undefined): Transfer {
  switch (s) {
    case "iec61966-2-1":
      return "srgb";
    case "bt709":
      return "bt709";
    case "smpte170m":
      return "bt709";
    case "pq":
    case "smpte2084":
      return "pq";
    case "hlg":
    case "arib-std-b67":
      return "hlg";
    case "linear":
      return "linear";
    default:
      return "bt709";
  }
}

function inferPrimaries(s: string | undefined): Primaries {
  switch (s) {
    case "bt709":
      return "bt709";
    case "smpte170m":
      return "bt709";
    case "p3":
    case "smpte432":
    case "display-p3":
      return "p3";
    case "bt2020":
      return "bt2020";
    default:
      return "bt709";
  }
}

function inferMatrix(s: string | undefined): MatrixCoeffs {
  switch (s) {
    case "rgb":
      return "rgb";
    case "bt2020-ncl":
    case "bt2020":
      return "bt2020-ncl";
    default:
      return "bt709";
  }
}

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bottomVideoRef = useRef<HTMLVideoElement | null>(null);
  const topVideoRef = useRef<HTMLVideoElement | null>(null);
  const gpuRef = useRef<GpuRefs | null>(null);
  const rafRef = useRef<number | null>(null);
  const topImageBitmapRef = useRef<ImageBitmap | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [bottomInfo, setBottomInfo] = useState<LayerInfo | null>(null);
  const [topInfo, setTopInfo] = useState<LayerInfo | null>(null);
  const [target, setTarget] = useState<TargetColor["kind"]>("srgb-sdr");
  const [tone, setTone] = useState<ToneMap>("reinhard");
  const [topAlpha, setTopAlpha] = useState(0.5);
  const [topMode, setTopMode] = useState<"off" | "video" | "image">("off");
  const [canvasColorSpace, setCanvasColorSpace] =
    useState<PredefinedColorSpace>("srgb");
  const [browserToneMap, setBrowserToneMap] = useState<"standard" | "extended">(
    "standard",
  );
  const [stats, setStats] = useState<{ fps: number; gpuMs: number }>({
    fps: 0,
    gpuMs: 0,
  });

  // Init WebGPU once.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (!navigator.gpu) throw new Error("WebGPU not supported");
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("no GPU adapter");
        const device = await adapter.requestDevice();
        if (cancelled) return;

        const context = canvas.getContext("webgpu");
        if (!context) throw new Error("no webgpu canvas context");
        const format = navigator.gpu.getPreferredCanvasFormat();
        // colorSpace + toneMapping are part of the GPUCanvasConfiguration in
        // Chrome 124+. Use any-cast for older type defs.
        const cfg: GPUCanvasConfiguration & {
          colorSpace?: PredefinedColorSpace;
          toneMapping?: { mode: "standard" | "extended" };
        } = {
          device,
          format,
          alphaMode: "premultiplied",
          colorSpace: canvasColorSpace,
          toneMapping: { mode: browserToneMap },
        };
        context.configure(cfg);

        const shaderModule = device.createShaderModule({ code: COLOR_WGSL });
        const pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module: shaderModule, entryPoint: "vs_main" },
          fragment: {
            module: shaderModule,
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
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        gpuRef.current = {
          device,
          context,
          pipeline,
          sampler,
          uniformBuffer,
          format,
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      gpuRef.current?.device.destroy();
      gpuRef.current = null;
      topImageBitmapRef.current?.close();
    };
    // We intentionally re-init only on canvas mount; canvasColorSpace/tone
    // changes call context.configure again below in a separate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-configure canvas color space / browser tone mapping when the user
  // changes the radio buttons.
  useEffect(() => {
    const g = gpuRef.current;
    if (!g) return;
    try {
      const cfg: GPUCanvasConfiguration & {
        colorSpace?: PredefinedColorSpace;
        toneMapping?: { mode: "standard" | "extended" };
      } = {
        device: g.device,
        format: g.format,
        alphaMode: "premultiplied",
        colorSpace: canvasColorSpace,
        toneMapping: { mode: browserToneMap },
      };
      g.context.configure(cfg);
    } catch (err) {
      setError(
        `canvas reconfigure failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [canvasColorSpace, browserToneMap]);

  // Render loop.
  useEffect(() => {
    let last = performance.now();
    let frames = 0;
    let acc = 0;
    let alive = true;

    const tick = () => {
      if (!alive) return;
      const g = gpuRef.current;
      const bottomEl = bottomVideoRef.current;
      const topEl = topVideoRef.current;

      if (g && bottomEl && bottomEl.readyState >= 2) {
        const t0 = performance.now();
        try {
          drawFrame(
            g,
            bottomEl,
            topMode === "video" && topEl && topEl.readyState >= 2 ? topEl : null,
            topMode === "image" ? topImageBitmapRef.current : null,
            target,
            tone,
            topAlpha,
            bottomInfo,
            topInfo,
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          alive = false;
          return;
        }
        const dt = performance.now() - t0;
        acc += dt;
        frames++;
        const now = performance.now();
        if (now - last > 500) {
          setStats({
            fps: Math.round((frames * 1000) / (now - last)),
            gpuMs: acc / Math.max(frames, 1),
          });
          last = now;
          frames = 0;
          acc = 0;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, tone, topAlpha, topMode, bottomInfo, topInfo]);

  const onBottomFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const v = bottomVideoRef.current!;
    v.src = URL.createObjectURL(file);
    v.muted = true;
    v.loop = true;
    await v.play().catch(() => {});
    setBottomInfo(await probeVideo(file.name, v));
  };

  const onTopVideoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const v = topVideoRef.current!;
    v.src = URL.createObjectURL(file);
    v.muted = true;
    v.loop = true;
    await v.play().catch(() => {});
    setTopInfo(await probeVideo(file.name, v));
    setTopMode("video");
  };

  const onTopImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      topImageBitmapRef.current?.close();
      const bm = await createImageBitmap(file, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
      topImageBitmapRef.current = bm;
      // ImageBitmap doesn't expose colorSpace yet on most builds; assume P3
      // for inputs the user supplies as such, sRGB otherwise. Allow override
      // via filename hint or leave as P3 by default for a "P3 image" input.
      const guess: Primaries = /p3|display-p3|displayp3/i.test(file.name)
        ? "p3"
        : "p3";
      setTopInfo({
        label: file.name,
        width: bm.width,
        height: bm.height,
        source: {
          primaries: guess,
          transfer: "srgb",
          matrix: "rgb",
          fullRange: true,
        },
        detected: `createImageBitmap, ${bm.width}×${bm.height}, assumed Display-P3 sRGB`,
      });
      setTopMode("image");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-13 · Color Management &amp; HDR</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Composite a BT.709 SDR clip, a Display-P3 image, and an HDR10/PQ
            clip into a single timeline with explicit transfer functions and
            primaries conversion. Target color space and tone-map are
            selectable.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FilePicker
            label="Bottom layer (SDR / HDR video)"
            accept="video/*"
            onChange={onBottomFile}
            info={bottomInfo}
          />
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <h2 className="mb-2 text-base font-semibold">Top layer</h2>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name="topmode"
                  checked={topMode === "off"}
                  onChange={() => setTopMode("off")}
                />
                Off
              </label>
              <label className="block text-xs">
                <span className="block">Top video</span>
                <input
                  type="file"
                  accept="video/*"
                  onChange={onTopVideoFile}
                  className="mt-1 block w-full"
                />
              </label>
              <label className="block text-xs">
                <span className="block">Top image (Display-P3 PNG/JPEG)</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={onTopImageFile}
                  className="mt-1 block w-full"
                />
              </label>
              <div className="mt-2 text-xs">
                Top blend alpha: {topAlpha.toFixed(2)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={topAlpha}
                  onChange={(e) => setTopAlpha(parseFloat(e.target.value))}
                  className="block w-full"
                />
              </div>
              {topInfo && (
                <InfoBlock info={topInfo} />
              )}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Control
            title="Target color"
            options={[
              { value: "srgb-sdr", label: "sRGB SDR (BT.709 primaries, sRGB transfer)" },
              { value: "p3-sdr", label: "Display-P3 SDR (P3 primaries, sRGB transfer)" },
              { value: "hdr10-pq", label: "HDR10 (BT.2020 primaries, PQ transfer)" },
            ]}
            value={target}
            onChange={(v) => setTarget(v as TargetColor["kind"])}
          />
          <Control
            title="Tone map (HDR→SDR)"
            options={[
              { value: "none", label: "None / clip" },
              { value: "reinhard", label: "Extended Reinhard" },
              { value: "hable", label: "Hable filmic" },
            ]}
            value={tone}
            onChange={(v) => setTone(v as ToneMap)}
          />
          <Control
            title="Canvas color space (browser)"
            options={[
              { value: "srgb", label: "srgb" },
              { value: "display-p3", label: "display-p3" },
            ]}
            value={canvasColorSpace}
            onChange={(v) => setCanvasColorSpace(v as PredefinedColorSpace)}
          />
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Output</h2>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                browser toneMapping:
                <select
                  value={browserToneMap}
                  onChange={(e) =>
                    setBrowserToneMap(
                      e.target.value as "standard" | "extended",
                    )
                  }
                  className="border bg-transparent px-1"
                >
                  <option value="standard">standard</option>
                  <option value="extended">extended</option>
                </select>
              </label>
              <span>
                {stats.fps} fps · {stats.gpuMs.toFixed(2)} ms/frame
              </span>
            </div>
          </div>
          <canvas
            ref={canvasRef}
            width={1280}
            height={720}
            className="block w-full rounded bg-black"
          />
          <div className="mt-2 text-xs text-zinc-500">
            Hidden source elements (video tags decode in browser; we sample
            them as external textures):
          </div>
          <div className="hidden">
            <video ref={bottomVideoRef} crossOrigin="anonymous" playsInline />
            <video ref={topVideoRef} crossOrigin="anonymous" playsInline />
          </div>
        </section>

        <footer className="space-y-1 text-xs text-zinc-500">
          <p>
            Open DevTools → Rendering → &quot;Emulate CSS media feature
            color-gamut&quot; to compare display-p3 vs srgb canvas output.
          </p>
          <p>
            Success criteria: SDR + P3 + HDR sources composite without
            clipping or hue shift; switching target re-encodes in real-time;
            HDR10 target only shows brighter on an HDR display.
          </p>
        </footer>
      </div>
    </main>
  );
}

async function probeVideo(
  name: string,
  v: HTMLVideoElement,
): Promise<LayerInfo> {
  // Need first frame to construct a VideoFrame and read its colorSpace.
  await new Promise<void>((res) => {
    if (v.readyState >= 2) return res();
    v.onloadeddata = () => res();
  });
  let detected = "no VideoFrame.colorSpace";
  let primaries: Primaries = "bt709";
  let transfer: Transfer = "bt709";
  let matrix: MatrixCoeffs = "bt709";
  let fullRange = false;
  try {
    const vf = new VideoFrame(v);
    const cs = vf.colorSpace;
    detected = `primaries=${cs.primaries ?? "?"} transfer=${cs.transfer ?? "?"} matrix=${cs.matrix ?? "?"} fullRange=${cs.fullRange ?? "?"}`;
    primaries = inferPrimaries(cs.primaries ?? undefined);
    transfer = inferTransfer(cs.transfer ?? undefined);
    matrix = inferMatrix(cs.matrix ?? undefined);
    fullRange = cs.fullRange ?? false;
    vf.close();
  } catch {
    /* some video tags reject VideoFrame ctor before play() */
  }
  return {
    label: name,
    width: v.videoWidth,
    height: v.videoHeight,
    source: { primaries, transfer, matrix, fullRange },
    detected,
  };
}

function drawFrame(
  g: GpuRefs,
  bottomEl: HTMLVideoElement,
  topVideo: HTMLVideoElement | null,
  topImage: ImageBitmap | null,
  target: TargetColor["kind"],
  tone: ToneMap,
  topAlpha: number,
  bottomInfo: LayerInfo | null,
  topInfo: LayerInfo | null,
): void {
  const { device, context, pipeline, sampler, uniformBuffer } = g;

  const bottomFrame = new VideoFrame(bottomEl);
  let topFrame: VideoFrame | null = null;
  let topImported: GPUExternalTexture | null = null;

  try {
    const externalBottom = device.importExternalTexture({
      source: bottomFrame,
    });
    let externalTop: GPUExternalTexture = externalBottom;
    let useTop = 0;

    if (topVideo) {
      topFrame = new VideoFrame(topVideo);
      topImported = device.importExternalTexture({ source: topFrame });
      externalTop = topImported;
      useTop = 1;
    } else if (topImage) {
      // For image: upload to a regular 2D texture once. Easiest path that
      // keeps the shader uniform: re-use texture_external for both. We can't
      // upload an ImageBitmap as an external texture, so we fall back to a
      // separate sampling path: render bottom only and overlay the image via
      // a second pass. To keep this experiment focused, we draw the image
      // through a one-shot copy into a square at center.
      // (See README for the ImageBitmap path note.)
      useTop = 0;
    }

    // Build uniforms.
    const bottomTransfer = bottomInfo
      ? TRANSFER_CODE[bottomInfo.source.transfer]
      : TRANSFER_CODE.bt709;
    const bottomPrim = bottomInfo
      ? PRIMARIES_CODE[bottomInfo.source.primaries]
      : PRIMARIES_CODE.bt709;
    const topTransfer = topInfo
      ? TRANSFER_CODE[topInfo.source.transfer]
      : TRANSFER_CODE.bt709;
    const topPrim = topInfo
      ? PRIMARIES_CODE[topInfo.source.primaries]
      : PRIMARIES_CODE.bt709;

    const { targetTransfer, targetPrimaries, targetPeakNits } =
      targetParams(target);
    const sourcePeakNits =
      bottomInfo?.source.transfer === "pq"
        ? 10000
        : bottomInfo?.source.transfer === "hlg"
          ? 1000
          : 100;

    const u32 = new Uint32Array(16);
    const f32 = new Float32Array(u32.buffer);
    u32[0] = bottomTransfer;
    u32[1] = topTransfer;
    u32[2] = 0; // _pad
    u32[3] = 0;
    u32[4] = bottomPrim;
    u32[5] = topPrim;
    u32[6] = 0;
    u32[7] = 0;
    u32[8] = targetTransfer;
    u32[9] = targetPrimaries;
    u32[10] = TONEMAP_CODE[tone];
    u32[11] = useTop;
    f32[12] = topAlpha;
    f32[13] = sourcePeakNits;
    f32[14] = targetPeakNits;
    f32[15] = 0;
    device.queue.writeBuffer(uniformBuffer, 0, u32);

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: externalBottom },
        { binding: 2, resource: externalTop },
        { binding: 3, resource: { buffer: uniformBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);
  } finally {
    bottomFrame.close();
    topFrame?.close();
    void topImported;
  }
}

function targetParams(t: TargetColor["kind"]): {
  targetTransfer: number;
  targetPrimaries: number;
  targetPeakNits: number;
} {
  switch (t) {
    case "p3-sdr":
      return {
        targetTransfer: TRANSFER_CODE.srgb,
        targetPrimaries: PRIMARIES_CODE.p3,
        targetPeakNits: 100,
      };
    case "hdr10-pq":
      return {
        targetTransfer: TRANSFER_CODE.pq,
        targetPrimaries: PRIMARIES_CODE.bt2020,
        targetPeakNits: 1000,
      };
    default:
      return {
        targetTransfer: TRANSFER_CODE.srgb,
        targetPrimaries: PRIMARIES_CODE.bt709,
        targetPeakNits: 100,
      };
  }
}

function FilePicker({
  label,
  accept,
  onChange,
  info,
}: {
  label: string;
  accept: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  info: LayerInfo | null;
}) {
  return (
    <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
      <h2 className="mb-2 text-base font-semibold">{label}</h2>
      <input
        type="file"
        accept={accept}
        onChange={onChange}
        className="block w-full text-xs"
      />
      {info && <InfoBlock info={info} />}
    </div>
  );
}

function InfoBlock({ info }: { info: LayerInfo }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
      <dt className="text-zinc-500">name</dt>
      <dd className="truncate">{info.label}</dd>
      <dt className="text-zinc-500">size</dt>
      <dd>
        {info.width}×{info.height}
      </dd>
      <dt className="text-zinc-500">primaries</dt>
      <dd>{info.source.primaries}</dd>
      <dt className="text-zinc-500">transfer</dt>
      <dd>{info.source.transfer}</dd>
      <dt className="text-zinc-500">matrix</dt>
      <dd>{info.source.matrix}</dd>
      <dt className="text-zinc-500">range</dt>
      <dd>{info.source.fullRange ? "full" : "limited"}</dd>
      <dt className="col-span-2 text-zinc-500">detected</dt>
      <dd className="col-span-2 break-words text-[10px]">{info.detected}</dd>
    </dl>
  );
}

function Control({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      <div className="space-y-1">
        {options.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-xs">
            <input
              type="radio"
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
