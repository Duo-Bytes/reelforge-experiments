# Exp-22 · GPU Text Rendering (MSDF) for Titles & Lower-Thirds

## Goal

Bake a signed-distance-field atlas from an arbitrary font at runtime,
upload it to a `GPUTexture`, and render text in WGSL using
screen-space-derivative anti-aliasing so glyphs stay crisp at any zoom
or rotation. Prove that the bake → upload → sample loop is feasible
without shipping a precomputed atlas.

## App Location

`apps/exp-22-msdf-text/`

## Why This Matters in the Full NLE

Title cards, lower-thirds, and any kerned/animated text layer live or
die by how the glyph rasteriser behaves under transform. `fillText`
into Canvas2D gives you bilinear mush past ~2× zoom and a re-raster
storm during rotation. SDF/MSDF samples a single static texture and
recovers crisp edges via `fwidth()` — the only path that survives
animated transforms at 60 fps.

## Key APIs

| API | Where used |
|---|---|
| `FontFace.load()` / `document.fonts.add()` | Load a Google-fonts woff2 at runtime |
| `OffscreenCanvas` + `ctx.fillText` | Rasterise each glyph at high res for the SDF source |
| Brute-force CPU SDF pass | Convert per-glyph alpha bitmap into a distance field |
| `GPUTexture { format: "r8unorm" }` | Final atlas upload |
| WGSL `fwidth(dist)` + `smoothstep` | Resolution-independent edge AA |

## Approach / Pipeline

1. Load a single open-licensed font via `FontFace.load(url)` and add to
   `document.fonts`.
2. For ASCII 32..126: render each glyph to an `OffscreenCanvas` cell
   (e.g., 48×48 px on a 16×16 grid → 768×768 atlas).
3. CPU SDF pass: for each pixel in the atlas, compute the signed
   distance to the nearest opacity boundary (8-direction brute force
   over a 16-px search radius). Pack into a single-channel `Uint8Array`
   where 128 is "on the edge".
4. Upload as `r8unorm`; sample in WGSL. The shader recovers a sharp
   edge with:

   ```wgsl
   let d = textureSample(atlas, samp, uv).r;
   let w = fwidth(d);
   let a = smoothstep(0.5 - w, 0.5 + w, d);
   ```

5. Render a title string with per-glyph quads and a uniform buffer of
   per-glyph atlas rects + advances.
6. Sliders for scale (100 % → 2000 %) and a rotation animation; the
   glyph quad transforms in the vertex stage.
7. Debug view: render the raw SDF atlas to a corner inset.

## Success Criteria

1. At 100 % the title looks like a Canvas2D baseline (no obvious
   blurring/clipping).
2. Zooming to 2000 % preserves crisp edges — no bilinear mush.
3. Rotation animates at 60 fps; the atlas is built once and never
   re-touched per frame.
4. The atlas inset matches the glyph order in the rendered title (sanity
   check on the rect lookup).

## Foot-guns

- True MSDF is 3-channel and uses median-of-three to preserve sharp
  corners (Chlumsky 2015). This experiment ships **plain SDF** for
  simplicity; production should swap the bake step for a real MSDF
  generator (e.g., `msdf-atlas-gen` precomputed assets).
- CPU brute-force SDF is O(n² · r²). Fine for one ASCII bake at startup;
  do *not* call it per frame. A real implementation would use jump-
  flooding or a Felzenszwalb 1-D EDT pass.
- `FontFace.load()` returns *before* the font is rasterised by the
  platform — `await document.fonts.ready` before drawing the bake
  source or you'll get a fallback glyph in the atlas.
- `fwidth` in WGSL is only available in fragment stage; using it in
  vertex code is a compile error.
- RTL + complex shaping (Arabic, Devanagari, CJK with vertical writing)
  are explicitly out of scope. Use.GPU's text renderer notes the same
  carve-out; production needs HarfBuzz-wasm + ICU.
