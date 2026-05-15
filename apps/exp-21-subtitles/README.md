# exp-21 · Subtitle/Caption Rendering (ASS + WebVTT)

## Purpose

Prove that an NLE running entirely in the browser can render both major
subtitle interchange formats — **WebVTT** (the web standard) and **ASS**
(the dominant fan-sub / karaoke format) — against a scrubbable playhead,
without taking a hard dependency on libass-WASM in the preview path.

VTT renders via a DOM overlay (positioned `<div>`s). ASS renders via a
hand-rolled Canvas2D pass running on an `OffscreenCanvas` inside a
`Worker`; the worker returns an `ImageBitmap` each frame which the main
thread blits into a `bitmaprenderer` canvas.

## How to run

```
pnpm --filter exp-21-subtitles dev
```

No file picker — two sample tracks (`SAMPLE_VTT`, `SAMPLE_ASS`) are
hardcoded in `src/lib/samples.ts`. Swap with the tab buttons.

## What to look for

- The playhead slider (0–30 s) and the Play button drive cue activation.
- The "Active cues" panel updates in real time as you scrub — sanity check
  for `activeCues()` + `cueAlpha()`.
- VTT mode: cue #1 sits near the bottom, cue #2 jumps to the top-left
  (`align:start line:10%`), cue #4 right-aligns.
- ASS mode: title card fades in/out via `\fad(400,400)`; later cues
  exercise the full 9-cell numpad (`\an1` through `\an9`); a yellow cue
  uses `\c&H00FFFF&`.
- The worker reports a per-frame render time below the controls — should
  stay well under 4 ms for this sample.
- Swap tabs back and forth a handful of times: the worker is terminated
  on unmount and re-created on remount; no leaked workers (check the
  browser's task-manager / devtools workers panel).

## Files

- `src/lib/vtt.ts` — WebVTT parser (timestamps + `align`/`line` settings).
- `src/lib/ass.ts` — ASS parser: `[Script Info]`, `[V4+ Styles]`,
  `[Events]`, plus override extraction for `\an`, `\fad`, `\c`. Time
  helper `cueAlpha()` returns 0..1 for linear in/out fades.
- `src/lib/samples.ts` — inline VTT and ASS test scripts.
- `src/workers/ass.worker.ts` — receives the parsed doc once, renders one
  frame per request, posts back an `ImageBitmap`.
- `src/app/page.tsx` — playhead state, mode switch, DOM overlay for VTT,
  worker plumbing for ASS.

## Success bar

1. Scrubbing 0 → 30 s makes cues appear and disappear at the right times
   in both modes.
2. ASS `\an8` (top-centre) and `\an2` (bottom-centre) land on the right
   edges.
3. `\fad(800, 800)` produces a visible ramp into and out of the cue.
4. ASS worker render time stays under 4 ms / frame; no main-thread
   blocking when scrubbing.
5. Toggling between VTT and ASS 10× leaves no orphaned workers.

## Known limits

- **ASS subset only**. Implemented overrides: `\an`, `\fad`, `\c`,
  `\N`. No `\t`-animations, no karaoke (`\k`), no vector drawing
  (`\p1`), no transforms, no clips. Production renderers must use
  **SubtitlesOctopus** (libass-WASM); shipping libass into a de-risk
  experiment was deemed too heavy.
- RTL bidi handling is whatever the underlying Canvas2D / browser does;
  no explicit shaping.
- The PlayResX / PlayResY scaling is approximate — we scale font sizes
  by the canvas's vertical dimension but don't enforce a strict aspect.
