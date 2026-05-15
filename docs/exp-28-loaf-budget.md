# Exp-28 · Long Animation Frames Performance Budget

## Goal

Install a continuous `long-animation-frame` PerformanceObserver in a
realistic shell, attribute blocking work to specific scripts and event
handlers, and prove the dashboard fails (red banner) when median LoAF
goes above 50 ms in a scripted scrub-and-edit session. Output a JSON
report compatible with a CI gate.

## App Location

`apps/exp-28-loaf-budget/`

## Why This Matters in the Full NLE

The Long Tasks API only measures CPU time on the main thread. It does
*not* include the rendering steps the browser performs after script
runs, which is precisely where a 60 fps timeline drops frames.
Long Animation Frames (Chrome 123+) wraps the entire frame including
style/layout/paint and exposes the scripts that contributed —
the only signal that maps cleanly to "did the user see a stutter?".
Without this, perf regressions land silently.

## Key APIs

| API | Where used |
|---|---|
| `new PerformanceObserver({ type: "long-animation-frame", buffered: true })` | Subscribe |
| `PerformanceLongAnimationFrameTiming.scripts[]` | Per-script attribution |
| `entry.duration`, `entry.renderStart`, `entry.styleAndLayoutStart` | Slice the frame |
| `entry.forcedStyleAndLayoutDuration` | Catch layout thrash |
| `script.invoker`, `script.sourceURL`, `script.sourceFunctionName` | Map back to code |
| `performance.measureUserAgentSpecificMemory()` | Optional cross-check |

## Approach

1. Feature-detect `PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")`.
   If absent, render an explanatory banner — Chrome 123+ only.
2. Subscribe once at mount, keep a rolling 30 s window of entries in
   state, disconnect on unmount.
3. Dashboard:
   - median / p95 / max LoAF duration over the last 30 s
   - total count of long animation frames
   - top contributing scripts (grouped by `sourceURL` + `sourceFunctionName`,
     summed `duration`)
   - the forced-layout share of each frame (catches `getBoundingClientRect`
     in a loop)
4. Load generators (each runs for 5 s):
   - **Block 100 ms** — `while (now < start + 100) {}` once per frame
   - **Layout thrash** — read `offsetWidth` then write `style.width` on
     200 nodes in a loop
   - **React state churn** — set state at 240 Hz on a 1 k-row list
   - **Idle** — baseline
5. Pass/fail banner: green when median LoAF over the last 10 s is
   < 50 ms, red otherwise.
6. "Download report (JSON)" exports the rolling buffer as a single doc
   for CI parsing.

## Success Criteria

1. Median LoAF in "Idle" mode is below 50 ms on a mid-tier laptop.
2. Each load generator produces a visible spike in the distribution and
   shows up in the top-scripts attribution table within 1 s.
3. The pass/fail banner flips red within 2 s of triggering the 100 ms
   blocker and back to green within 3 s of stopping it.
4. The JSON report contains `entry.scripts[]` with non-empty
   `sourceURL` / `invoker` fields, or documents why they were `""`
   (cross-origin scripts elide attribution).

## Foot-guns

- LoAF is Chrome 123+. Feature-gate everything; do not throw on Firefox.
- `entry.scripts` is empty when the browser cannot attribute (cross-
  origin without `Timing-Allow-Origin`, internal browser work). Don't
  treat empty as "nothing happened".
- The observer fires *after* the frame. Don't try to react synchronously
  to a slow frame — react on the next macrotask.
- Median over too small a window flickers; 10 s minimum for the gate,
  30 s for the dashboard.
- Forced style/layout time can dominate even when total script time is
  tiny — surface `forcedStyleAndLayoutDuration` separately, otherwise
  layout thrash hides as "no JS ran".
