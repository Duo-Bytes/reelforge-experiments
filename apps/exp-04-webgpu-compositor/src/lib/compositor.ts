import { COMPOSITE_WGSL } from "../shaders/composite.wgsl";

export type CompositorContext = {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  pipeline: GPURenderPipeline;
  sampler: GPUSampler;
  uniformBuffer: GPUBuffer;
};

export async function initCompositor(
  canvas: HTMLCanvasElement,
): Promise<CompositorContext> {
  if (!navigator.gpu) throw new Error("WebGPU not supported");

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");

  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("no webgpu canvas context");

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const shaderModule = device.createShaderModule({ code: COMPOSITE_WGSL });
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
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  return { device, context, format, pipeline, sampler, uniformBuffer };
}

/**
 * Render up to two VideoFrames as a single composite.
 *
 * IMPORTANT: this function MUST run synchronously between
 * `importExternalTexture` and `queue.submit`. Awaiting anything in between
 * invalidates the external texture binding (Chrome expires it at the end of
 * the current task).
 *
 * Caller is responsible for closing each VideoFrame *after* `submit()`
 * returns. The submit call schedules GPU work and returns immediately, but
 * the GPU may still be reading the frame for a few ms — closing too early
 * is allowed because Chrome's WebGPU implementation copies/refs internally
 * once submit is called.
 */
export function renderComposite(
  ctx: CompositorContext,
  bottom: VideoFrame,
  top: VideoFrame | null,
  topAlpha: number,
): void {
  const { device, context, pipeline, sampler, uniformBuffer } = ctx;

  // Upload uniforms first; these are stable across the submit boundary.
  const u = new Float32Array(4);
  u[0] = topAlpha;
  u[1] = top ? 1 : 0;
  device.queue.writeBuffer(uniformBuffer, 0, u);

  const externalBottom = device.importExternalTexture({ source: bottom });
  // Always bind two external textures — when only one frame, alias to bottom.
  const externalTop = top
    ? device.importExternalTexture({ source: top })
    : externalBottom;

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
}
