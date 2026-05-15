// WebGPU initialisation helpers shared by the page.

export type LutGpu = {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  pipeline: GPURenderPipeline;
  sampler: GPUSampler;
  paramsBuffer: GPUBuffer;
};

export async function initGpu(
  canvas: HTMLCanvasElement,
  vertexWGSL: string,
  fragmentWGSL: string,
): Promise<LutGpu> {
  if (!("gpu" in navigator)) {
    throw new Error("navigator.gpu not available — this browser lacks WebGPU");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter");
  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Could not get webgpu context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const vsModule = device.createShaderModule({ code: vertexWGSL });
  const fsModule = device.createShaderModule({ code: fragmentWGSL });

  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: vsModule, entryPoint: "vs_main" },
    fragment: {
      module: fsModule,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    addressModeW: "clamp-to-edge",
  });

  // 4 floats — matches the `Params` struct in WGSL (16-byte aligned).
  const paramsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  return { device, context, format, pipeline, sampler, paramsBuffer };
}

export function uploadLutTexture(
  device: GPUDevice,
  size: number,
  rgbaF32: Float32Array,
): GPUTexture {
  // Convert Float32 -> Float16 manually. rgba16float is the most widely
  // supported sampleable 3D texture format with linear filtering.
  const half = new Uint16Array(rgbaF32.length);
  for (let i = 0; i < rgbaF32.length; i++) half[i] = f32ToF16(rgbaF32[i]);

  const tex = device.createTexture({
    size: { width: size, height: size, depthOrArrayLayers: size },
    dimension: "3d",
    format: "rgba16float",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.writeTexture(
    { texture: tex },
    half.buffer,
    {
      bytesPerRow: size * 4 * 2,   // 4 channels * 2 bytes
      rowsPerImage: size,
    },
    { width: size, height: size, depthOrArrayLayers: size },
  );
  return tex;
}

// IEEE 754 binary32 -> binary16 conversion. No subnormal handling.
function f32ToF16(v: number): number {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = v;
  const x = new Uint32Array(buf)[0];
  const sign = (x >>> 31) & 0x1;
  let exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp === 0xff) {
    // Inf/NaN.
    return (sign << 15) | (0x1f << 10) | (mant ? 0x200 : 0);
  }
  // Re-bias from 127 to 15.
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return (sign << 15) | (0x1f << 10);   // overflow -> inf
  if (exp <= 0) {
    // Subnormals: flush to zero for simplicity.
    return sign << 15;
  }
  return (sign << 15) | (exp << 10) | (mant >>> 13);
}
