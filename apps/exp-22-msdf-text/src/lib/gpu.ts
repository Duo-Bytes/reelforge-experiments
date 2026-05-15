// WebGPU init helpers for the text demo.

import {
  ATLAS_VIEW_FS,
  ATLAS_VIEW_VS,
  TEXT_FS,
  TEXT_VS,
} from "./shaders";

export type TextGpu = {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  textPipeline: GPURenderPipeline;
  atlasPipeline: GPURenderPipeline;
  sampler: GPUSampler;
  uniformBuffer: GPUBuffer;
};

export async function initGpu(canvas: HTMLCanvasElement): Promise<TextGpu> {
  if (!("gpu" in navigator)) throw new Error("navigator.gpu not available");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Could not get webgpu context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const textPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: device.createShaderModule({ code: TEXT_VS }),
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 32,            // 8 floats per instance
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module: device.createShaderModule({ code: TEXT_FS }),
      entryPoint: "fs_main",
      targets: [
        {
          format,
          blend: {
            // Pre-multiplied alpha; the shader emits straight white with
            // alpha = sdf coverage.
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  const atlasPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: device.createShaderModule({ code: ATLAS_VIEW_VS }),
      entryPoint: "vs_main",
    },
    fragment: {
      module: device.createShaderModule({ code: ATLAS_VIEW_FS }),
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
  });

  const uniformBuffer = device.createBuffer({
    size: 48,    // 2 vec4 + vec2 + vec2 pad = 48 bytes (rounded to 16-byte align)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  return {
    device,
    context,
    format,
    textPipeline,
    atlasPipeline,
    sampler,
    uniformBuffer,
  };
}

export function uploadAtlasTexture(
  device: GPUDevice,
  width: number,
  height: number,
  pixels: Uint8Array,
): GPUTexture {
  const tex = device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: "r8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.writeTexture(
    { texture: tex },
    pixels.buffer,
    { bytesPerRow: width, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  return tex;
}
