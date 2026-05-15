# Exp-21 · Subtitle/Caption Rendering (ASS + WebVTT)

## Goal

Render both `.vtt` and `.ass` subtitles against a scrubbable timeline:
VTT via DOM/Canvas2D, ASS via a minimal in-house renderer running on an
`OffscreenCanvas` inside a Worker. Confirm that cues evaluate against a
playhead, that styled positioning (`\an`, fades) works, and that the
worker can hand back a `ImageBitmap` per frame without dropping below
60 fps.

## App Location

`apps/exp-21-subtitles/`

## Why This Matters in the Full NLE

ASS/SSA is the dominant fan-sub and karaoke format and "styling will be
removed when converting from ASS" — there is no clean lossy path to
VTT. Burn-in for export needs the same renderer the preview uses, so
the worker pipeline has to produce a texture, not just a DOM overlay.

## Key APIs

| API | Where used |
|---|---|
| `OffscreenCanvas` + `getContext('2d')` | ASS renderer, off-main-thread |
| `Worker(new URL('...', import.meta.url))` | Isolate cue evaluation + draw |
| `OffscreenCanvas.transferToImageBitmap()` | Hand the frame back to main |
| `TextTrackCue` / hand-rolled VTT parser | Cue store + lookup |
| `requestAnimationFrame` + a `playhead` clock | Drive cue evaluation |

## Approach / Pipeline

1. Two built-in samples ship inline: a small `.vtt` with 3-4 cues
   (including `align`/`line` positioning) and a small `.ass` with
   `[Events] Dialogue:` lines using `\an8`, `\fad`, basic colour.
2. The page evaluates `currentTime` against the cue list each rAF and
   emits the active cues.
3. VTT path: render active cues to a DOM overlay (one positioned `<div>`
   per cue). The "burn-in" preview also draws them to a Canvas2D for
   parity testing.
4. ASS path: post `{ playhead, cues }` to the worker; worker draws to an
   `OffscreenCanvas`, calls `transferToImageBitmap()`, posts the bitmap
   back. Main thread blits it into a preview canvas.
5. Side panel shows the parsed cue list with start/end and the visible
   subset for the current playhead.

## Success Criteria

1. Scrubbing the playhead from 0 → 30 s makes cues appear and disappear
   at the right times for both formats.
2. ASS `\an8` (top-centre) and `\an2` (bottom-centre) actually move the
   line to the correct edge of the canvas.
3. A fade tag (`\fad(500,500)`) ramps alpha in/out around the cue
   boundaries.
4. The worker stays under 4 ms per frame for the sample content;
   `requestAnimationFrame` on the main thread never falls below 60 fps.
5. Swapping samples doesn't leak workers or canvas contexts (verify by
   re-creating the source 10× and watching memory).

## Foot-guns

- ASS uses 1/100-second timestamps in `Dialogue:` lines (`0:00:01.50`,
  not `0:00:01.500`). Parsing the wrong precision shifts every cue.
- `\an` codes map to a 3×3 grid; the centre column (`\an2/5/8`) is
  *centre-aligned*, not *centred origin*. Easy to get +1 misalignment.
- `OffscreenCanvas.transferToImageBitmap()` empties the canvas — you
  must re-draw every frame. Forgetting this gives a one-frame flicker.
- Real ASS supports `\t`-animations, transforms, drawing commands and a
  full BBcode-style override block. This experiment implements the
  minimum subset; production uses **SubtitlesOctopus** (libass-WASM).
  Don't pull libass-WASM in here — too heavy for a de-risk demo.
- WebVTT cues use *fractional* seconds (`00:00:01.500`); ASS uses
  *centiseconds*. Same shape, different scale — separate parsers.
