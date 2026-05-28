// Test-pattern renderer + WGSL compute scope readback for exp-35.
//
// The source frame is uploaded to a GPUTexture and a single compute pass
// accumulates luma-waveform, RGB-parade, vectorscope, and histogram bins
// into atomic<u32> storage buffers, which are read back into the
// ScopeReadback shape the UI paints. The same pass plugs directly onto
// the exp-04 compositor's output texture (swap the writeTexture upload
// for the compositor's GPUTexture).

/// <reference types="@webgpu/types" />

export type ScopeReadback = {
  lumaWaveform: Uint32Array; // cols × 256
  rgbParade: Uint32Array; // 3 × cols × 256
  vectorscope: Array<[number, number, number]>; // (u, v, count)
  histogram: [Uint32Array, Uint32Array, Uint32Array]; // [r,g,b][256]
  maxBin: number;
  elapsedMs: number;
};

type Options = {
  sourceCanvas: HTMLCanvasElement;
  onReadback: (rb: ScopeReadback) => void;
};

const COLS = 128;
const BINS = 256;
const VEC_GRID = 128;

const COMPUTE_WGSL = /* wgsl */ `
struct U { width: u32, height: u32, cols: u32, vecGrid: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: U;
@group(0) @binding(2) var<storage, read_write> luma: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> parade: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> histo: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> vec: array<atomic<u32>>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.width || gid.y >= u.height) { return; }
  let c = textureLoad(src, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
  let r = u32(clamp(c.r, 0.0, 1.0) * 255.0 + 0.5);
  let g = u32(clamp(c.g, 0.0, 1.0) * 255.0 + 0.5);
  let b = u32(clamp(c.b, 0.0, 1.0) * 255.0 + 0.5);
  let yf = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  let Y = u32(clamp(yf, 0.0, 1.0) * 255.0 + 0.5);

  atomicAdd(&histo[0u * 256u + r], 1u);
  atomicAdd(&histo[1u * 256u + g], 1u);
  atomicAdd(&histo[2u * 256u + b], 1u);

  let col = min(u.cols - 1u, gid.x * u.cols / u.width);
  atomicAdd(&luma[col * 256u + Y], 1u);
  atomicAdd(&parade[0u * u.cols * 256u + col * 256u + r], 1u);
  atomicAdd(&parade[1u * u.cols * 256u + col * 256u + g], 1u);
  atomicAdd(&parade[2u * u.cols * 256u + col * 256u + b], 1u);

  // BT.709 Cb/Cr in [-0.5, 0.5].
  let Cb = -0.1146 * c.r - 0.3854 * c.g + 0.5 * c.b;
  let Cr = 0.5 * c.r - 0.4542 * c.g - 0.0458 * c.b;
  let gx = u32(clamp(Cb + 0.5, 0.0, 0.999) * f32(u.vecGrid));
  let gy = u32(clamp(Cr + 0.5, 0.0, 0.999) * f32(u.vecGrid));
  atomicAdd(&vec[gy * u.vecGrid + gx], 1u);
}
`;

export async function runScopes(opts: Options): Promise<() => void> {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    throw new Error("WebGPU unavailable");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  const device = await adapter.requestDevice();

  const w = opts.sourceCanvas.width;
  const h = opts.sourceCanvas.height;

  const tex = device.createTexture({
    size: [w, h],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  const lumaLen = COLS * BINS;
  const paradeLen = 3 * COLS * BINS;
  const histoLen = 3 * BINS;
  const vecLen = VEC_GRID * VEC_GRID;

  const mkStorage = (len: number) =>
    device.createBuffer({
      size: len * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  const mkReadback = (len: number) =>
    device.createBuffer({
      size: len * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

  const lumaBuf = mkStorage(lumaLen);
  const paradeBuf = mkStorage(paradeLen);
  const histoBuf = mkStorage(histoLen);
  const vecBuf = mkStorage(vecLen);
  const lumaRead = mkReadback(lumaLen);
  const paradeRead = mkReadback(paradeLen);
  const histoRead = mkReadback(histoLen);
  const vecRead = mkReadback(vecLen);

  const zeros = {
    luma: new Uint32Array(lumaLen),
    parade: new Uint32Array(paradeLen),
    histo: new Uint32Array(histoLen),
    vec: new Uint32Array(vecLen),
  };

  const uniformBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuf, 0, new Uint32Array([w, h, COLS, VEC_GRID]));

  const shaderModule = device.createShaderModule({ code: COMPUTE_WGSL });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: shaderModule, entryPoint: "main" },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: tex.createView() },
      { binding: 1, resource: { buffer: uniformBuf } },
      { binding: 2, resource: { buffer: lumaBuf } },
      { binding: 3, resource: { buffer: paradeBuf } },
      { binding: 4, resource: { buffer: histoBuf } },
      { binding: 5, resource: { buffer: vecBuf } },
    ],
  });

  const ctx2d = opts.sourceCanvas.getContext("2d");
  let stopped = false;
  let raf = 0;

  const tick = async () => {
    if (stopped || !ctx2d) return;
    const t0 = performance.now();

    // Upload the current source frame. (Swap for the compositor texture
    // to go fully zero-copy on the GPU.)
    const img = ctx2d.getImageData(0, 0, w, h);
    device.queue.writeTexture(
      { texture: tex },
      img.data,
      { bytesPerRow: w * 4, rowsPerImage: h },
      [w, h],
    );

    // Clear bins.
    device.queue.writeBuffer(lumaBuf, 0, zeros.luma);
    device.queue.writeBuffer(paradeBuf, 0, zeros.parade);
    device.queue.writeBuffer(histoBuf, 0, zeros.histo);
    device.queue.writeBuffer(vecBuf, 0, zeros.vec);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
    pass.end();
    encoder.copyBufferToBuffer(lumaBuf, 0, lumaRead, 0, lumaLen * 4);
    encoder.copyBufferToBuffer(paradeBuf, 0, paradeRead, 0, paradeLen * 4);
    encoder.copyBufferToBuffer(histoBuf, 0, histoRead, 0, histoLen * 4);
    encoder.copyBufferToBuffer(vecBuf, 0, vecRead, 0, vecLen * 4);
    device.queue.submit([encoder.finish()]);

    await Promise.all([
      lumaRead.mapAsync(GPUMapMode.READ),
      paradeRead.mapAsync(GPUMapMode.READ),
      histoRead.mapAsync(GPUMapMode.READ),
      vecRead.mapAsync(GPUMapMode.READ),
    ]);
    if (stopped) {
      lumaRead.unmap();
      paradeRead.unmap();
      histoRead.unmap();
      vecRead.unmap();
      return;
    }

    const luma = new Uint32Array(lumaRead.getMappedRange().slice(0));
    const parade = new Uint32Array(paradeRead.getMappedRange().slice(0));
    const histoFlat = new Uint32Array(histoRead.getMappedRange().slice(0));
    const vecFlat = new Uint32Array(vecRead.getMappedRange().slice(0));
    lumaRead.unmap();
    paradeRead.unmap();
    histoRead.unmap();
    vecRead.unmap();

    let maxBin = 0;
    for (let i = 0; i < luma.length; i++) if (luma[i] > maxBin) maxBin = luma[i];

    const histogram: [Uint32Array, Uint32Array, Uint32Array] = [
      histoFlat.slice(0, BINS),
      histoFlat.slice(BINS, 2 * BINS),
      histoFlat.slice(2 * BINS, 3 * BINS),
    ];

    const vectorscope: Array<[number, number, number]> = [];
    for (let gy = 0; gy < VEC_GRID; gy++) {
      for (let gx = 0; gx < VEC_GRID; gx++) {
        const n = vecFlat[gy * VEC_GRID + gx];
        if (n === 0) continue;
        const u = ((gx + 0.5) / VEC_GRID) * 2 - 1;
        const v = ((gy + 0.5) / VEC_GRID) * 2 - 1;
        vectorscope.push([u, v, n]);
      }
    }

    opts.onReadback({
      lumaWaveform: luma,
      rgbParade: parade,
      vectorscope,
      histogram,
      maxBin,
      elapsedMs: performance.now() - t0,
    });

    raf = requestAnimationFrame(() => void tick());
  };

  raf = requestAnimationFrame(() => void tick());

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    // Buffers/texture are GC'd with the device; explicit destroy avoids
    // holding VRAM if the user restarts repeatedly.
    tex.destroy();
    device.destroy();
  };
}

export function renderTestPattern(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  kind: "smpte" | "ramp" | "skin",
) {
  ctx.clearRect(0, 0, w, h);
  if (kind === "smpte") {
    const bars: [number, number, number][] = [
      [192, 192, 192], [192, 192, 0], [0, 192, 192],
      [0, 192, 0], [192, 0, 192], [192, 0, 0], [0, 0, 192],
    ];
    const bw = w / bars.length;
    bars.forEach(([r, g, b], i) => {
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(i * bw, 0, bw, h * 0.7);
    });
    ctx.fillStyle = "rgb(0,0,0)";
    ctx.fillRect(0, h * 0.7, w, h * 0.3);
    ctx.fillStyle = "rgb(255,255,255)";
    ctx.fillRect(w * 0.4, h * 0.85, w * 0.2, h * 0.1);
  } else if (kind === "ramp") {
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#000");
    grad.addColorStop(1, "#fff");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  } else {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#f3d2b0");
    grad.addColorStop(0.5, "#d5a07a");
    grad.addColorStop(1, "#6c3c2b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
}
