// Plugin spec + helpers for exp-38.
//
// Plugins are compiled for real via GPUDevice.createShaderModule inside a
// sandboxed Worker (see workers/plugin.worker.ts) and previewed with a
// live WebGPU render pass. This module holds the shared types, the
// example plugin, validation, and the std140 uniform packer.

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
    // p is cast from untrusted JSON, so validate the shape at runtime.
    const { id, type } = param as { id?: unknown; type?: unknown };
    if (!id || typeof id !== "string") {
      throw new Error("param.id missing");
    }
    if (type !== "f32" && type !== "vec3") {
      throw new Error(`unsupported param type ${String(type)}`);
    }
  }
}

/**
 * Pack params into a std140 uniform buffer matching a WGSL `struct` whose
 * members are declared in `specs` order. f32 aligns to 4 bytes; vec3
 * aligns to 16 and occupies 12. The total is rounded up to 16. This
 * matches the layout WGSL uses for a `var<uniform>` struct, so the
 * example plugin's `Params { radius, intensity, tint }` lands correctly.
 */
export function packParams(
  specs: ParamSpec[],
  values: Record<string, ParamValue>,
): Float32Array {
  let cursor = 0; // in floats (4 bytes each)
  const writes: { index: number; data: number[] }[] = [];
  for (const spec of specs) {
    const v = values[spec.id] ?? spec.default;
    if (spec.type === "f32") {
      writes.push({ index: cursor, data: [typeof v === "number" ? v : 0] });
      cursor += 1;
    } else {
      // vec3 aligns to 16 bytes = 4 floats.
      cursor = Math.ceil(cursor / 4) * 4;
      const arr = Array.isArray(v) ? v : [0, 0, 0];
      writes.push({ index: cursor, data: [arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0] });
      cursor += 3;
    }
  }
  // Round the struct size up to a multiple of 16 bytes (4 floats).
  const sizeFloats = Math.max(4, Math.ceil(cursor / 4) * 4);
  const buf = new Float32Array(sizeFloats);
  for (const w of writes) buf.set(w.data, w.index);
  return buf;
}
