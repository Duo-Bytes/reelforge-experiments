# exp-22 · GPU Text Rendering (MSDF) for Titles & Lower-Thirds

## Purpose

Test whether an NLE can bake a glyph atlas at runtime (no pre-built assets
shipped) and render arbitrarily-transformed text in WGSL that stays sharp
under animation. The screen-space-derivative trick (`fwidth(d)` +
`smoothstep`) is the only way to get clean edges from a single static
texture as the user spins, scales, or zooms a title card.

We ship a **1-channel SDF** (not true MSDF). True MSDF preserves sharp
corners using median-of-three across three channels (Chlumsky 2015) and
needs a real generator (`msdf-atlas-gen` or similar). The `fwidth`-based
AA in the shader is identical either way; only the bake step changes.

## How to run

```
pnpm --filter exp-22-msdf-text dev
```

At boot we:

1. Load **Inter** from Google Fonts via `FontFace.load(url)` and add to
   `document.fonts`.
2. `await document.fonts.ready` — without this the platform raster isn't
   hot and `fillText` falls back to a system font.
3. Render every ASCII printable glyph (plus a few punctuation marks) to
   an OffscreenCanvas grid.
4. Convert the alpha bitmap into a signed-distance-field via brute force
   (8-radius, O(n²·r²)). Takes a few hundred ms.
5. Upload the SDF to a `GPUTexture { format: "r8unorm" }`.
6. Render a fullscreen-ish title quad with per-glyph instances.

## What to look for

- The title stays crisp from **100% to 2000%** scale — that's the point.
  Compare against a Canvas2D baseline (just open devtools and zoom in)
  to see bilinear mush.
- With "rotate" on, the title sweeps; no shimmer, no re-raster cost (the
  atlas never gets touched).
- The **SDF atlas** panel shows the raw single-channel field: grey
  background, glyphs as bright cores fading to dark edges, with a sharp
  ~50% isovalue at the boundary.
- The stats panel reports atlas bake time and per-frame GPU time. Atlas
  bake is single-digit ms × 100s — fine for startup, terrible for
  per-frame use.

## Files

- `src/lib/atlas.ts` — runtime SDF bake (Canvas2D → alpha → brute-force
  distance field), plus a `layoutString()` helper that emits per-glyph
  quad rects and atlas UVs.
- `src/lib/shaders.ts` — `TEXT_VS`/`TEXT_FS` for instanced glyph quads
  (`fwidth`-based AA) and an `ATLAS_VIEW_*` shader for the debug view.
- `src/lib/gpu.ts` — pipeline setup, atlas texture upload.
- `src/app/page.tsx` — atlas bake, render loop, scale + rotate controls.

## Success bar

1. At 100% the title is indistinguishable from a Canvas2D baseline.
2. At 2000% edges are still single-pixel-wide ramps, not bilinear blur.
3. Rotation animates at 60 fps; no atlas rework per frame.
4. The atlas inset shows the glyphs in the same order they appear in
   `ATLAS_CHARS`.

## Known foot-guns

- `FontFace.load()` resolves *before* the platform finishes rasterising
  the font. Without `await document.fonts.ready` the bake step uses a
  fallback glyph for everything. See `buildAtlas()`.
- `fwidth` is fragment-only in WGSL. Using it in vertex code is a compile
  error.
- CPU brute-force SDF is O(n² · r²). Fine at startup for a 512×512
  atlas; do **not** call it per frame. Production should use jump-
  flooding (Rong & Tan 2006) or Felzenszwalb 1-D EDT.
- RTL + complex shaping (Arabic, Devanagari, CJK vertical) is **out of
  scope**. A real implementation would route shaping through
  HarfBuzz-WASM + ICU.
- We use `r8unorm` (single channel). True MSDF needs `rgba8unorm` and a
  median-of-three sample in the fragment shader.
