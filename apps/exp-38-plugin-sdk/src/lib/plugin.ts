// Plugin spec + a minimal compile/preview simulation for exp-38.
// The real implementation will compile WGSL via GPUDevice.createShaderModule
// inside a sandboxed Worker. For now we render the plugin's effect via a 2D
// preview so the param/hot-reload UX can be exercised end-to-end.

export type ParamSpec =
  | {
      id: string;
      type: "f32";
      default: number;
      range?: [number, number];
    }
  | {
      id: string;
      type: "vec3";
      default: number[];
    };

export type ParamValue = number | number[];

export type Plugin = {
  id: string;
  name: string;
  version: string;
  kind: "filter";
  shader: string; // WGSL fragment entry source
  params: ParamSpec[];
};

export const EXAMPLE_PLUGIN: Plugin = {
  id: "com.reelforge.example.glow",
  name: "Glow",
  version: "0.1.0",
  kind: "filter",
  shader: `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;

struct Params { radius: f32, intensity: f32, tint: vec3<f32> };
@group(0) @binding(2) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(srcTex, srcSamp, uv);
  let blur = src.rgb * params.tint * params.intensity;
  return vec4<f32>(src.rgb + blur * params.radius / 64.0, src.a);
}`.trim(),
  params: [
    { id: "radius", type: "f32", default: 16.0, range: [0, 64] },
    { id: "intensity", type: "f32", default: 1.2, range: [0, 4] },
    { id: "tint", type: "vec3", default: [1.0, 0.9, 0.8] },
  ],
};

export function validatePlugin(p: Plugin): void {
  if (typeof p.id !== "string" || !/^[a-z0-9.-]+$/i.test(p.id)) {
    throw new Error("plugin.id must be a dotted identifier");
  }
  if (typeof p.shader !== "string" || p.shader.length < 16) {
    throw new Error("plugin.shader is empty");
  }
  if (!Array.isArray(p.params)) {
    throw new Error("plugin.params must be an array");
  }
  for (const param of p.params) {
    if (!param.id || typeof param.id !== "string") {
      throw new Error("param.id missing");
    }
    if (param.type !== "f32" && param.type !== "vec3") {
      throw new Error(`unsupported param type ${param.type}`);
    }
  }
}

// Simulate a compile step. v2: compile real WGSL, mount worker, return a
// ready handle. We sleep just enough for the UI to read realistic timing.
export async function compilePlugin(_p: Plugin): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
}

// 2D preview that responds to params so the hot-reload UX is visible.
export function paintPreview(
  canvas: HTMLCanvasElement,
  plugin: Plugin,
  values: Record<string, ParamValue>,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // base image: gradient + circle to make the glow effect visible
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#1f2937");
  grad.addColorStop(1, "#0f172a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const radius = numParam(values, "radius", 16);
  const intensity = numParam(values, "intensity", 1);
  const tint = vec3Param(values, "tint", [1, 1, 1]);

  // tinted glow circles
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 6; i++) {
    const r = radius * (1 + i * 0.5);
    const a = Math.min(1, intensity / (i + 1));
    ctx.fillStyle = `rgba(${Math.round(tint[0] * 255)},${Math.round(tint[1] * 255)},${Math.round(tint[2] * 255)},${a * 0.18})`;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, r * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // plugin id label
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText(`${plugin.name} · ${plugin.version}`, 10, h - 12);
}

function numParam(v: Record<string, ParamValue>, key: string, fallback: number): number {
  const raw = v[key];
  return typeof raw === "number" ? raw : fallback;
}

function vec3Param(v: Record<string, ParamValue>, key: string, fallback: number[]): number[] {
  const raw = v[key];
  return Array.isArray(raw) && raw.length === 3 ? raw : fallback;
}
