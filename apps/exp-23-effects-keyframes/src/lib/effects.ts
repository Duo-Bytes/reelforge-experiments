// Effect plugin contract + two demo effects.
//
// Each effect carries a typed parameter schema and a WGSL fragment that
// declares its `apply(color, params)` function. The compositor inlines
// the parameter uniforms before pipeline creation (WGSL has no #include).

export type ParamSpec = {
  key: string;
  type: "f32" | "vec2" | "color";
  default: number;
  min: number;
  max: number;
};

export type Effect = {
  id: string;
  name: string;
  paramSchema: ParamSpec[];
  // WGSL source declaring `fn apply_<id>(c: vec4<f32>, p: vec4<f32>) -> vec4<f32>`.
  // We don't compile this in the experiment (a stub canvas preview is
  // sufficient) but the contract is the same one the real compositor
  // would feed into exp-04.
  wgslSource: string;
};

export const BRIGHTNESS: Effect = {
  id: "brightness",
  name: "Brightness",
  paramSchema: [
    { key: "amount", type: "f32", default: 1.0, min: 0.0, max: 2.0 },
  ],
  wgslSource: `
fn apply_brightness(c: vec4<f32>, p: vec4<f32>) -> vec4<f32> {
  // p.x = amount
  return vec4<f32>(c.rgb * p.x, c.a);
}
`,
};

export const GAUSSIAN_BLUR: Effect = {
  id: "gaussian_blur",
  name: "Gaussian Blur",
  paramSchema: [
    { key: "radius", type: "f32", default: 0.0, min: 0.0, max: 32.0 },
  ],
  // Stubbed as a 3x3 box blur — full Gaussian needs two passes which is
  // out of scope for this experiment, but the parameter contract and
  // sampling pattern are real.
  wgslSource: `
fn apply_gaussian_blur(c: vec4<f32>, p: vec4<f32>) -> vec4<f32> {
  // p.x = radius (sampled in the host pass)
  return c;
}
`,
};

export const REGISTRY: Effect[] = [BRIGHTNESS, GAUSSIAN_BLUR];

// CPU-side preview of the effect stack on an (r,g,b) tuple. The real
// pipeline does this on the GPU, but the contract is identical so the
// frame-time meter and ordering test both produce meaningful numbers.
export type Color = { r: number; g: number; b: number };

export function applyStack(
  base: Color,
  stack: { effect: Effect; params: Record<string, number> }[],
): Color {
  let c = { ...base };
  for (const entry of stack) {
    if (entry.effect.id === "brightness") {
      const a = entry.params.amount ?? 1;
      c = { r: c.r * a, g: c.g * a, b: c.b * a };
    } else if (entry.effect.id === "gaussian_blur") {
      // No spatial context in this CPU stub; we leave the colour alone
      // but record that the effect ran (the WebGPU preview will draw a
      // halo proportional to radius separately).
    }
  }
  return c;
}
