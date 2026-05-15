# Exp-27 · Compute-Pressure Adaptive Quality

## Goal

Use `PressureObserver` to drive the preview compositor: drop preview
resolution, disable expensive effects, and pause background proxy
transcoding when the system enters `serious` or `critical`. Survive a
30-minute synthetic stress test without thermal jank. Demonstrate the
state machine + policy layer the real compositor will plug into.

## App Location

`apps/exp-27-compute-pressure/`

## Why This Matters in the Full NLE

Browser preview frequently competes with the rest of the OS for the
same cores and GPU. The first user-visible failure of a heavy preview
is not a crash — it's thermal throttling and macOS deciding to drop
the tab's priority. The Compute Pressure API shipped from Chrome 125
explicitly to let video-conferencing apps shed work *before* the
user notices. The same logic applies to NLE preview: a 4K timeline
should silently degrade to 1080p preview when the CPU goes
`serious`, and pause background proxy transcoding when it goes
`critical`.

## Key APIs

| API | Where used |
|---|---|
| `PressureObserver` (`cpu` source) | CPU pressure callbacks |
| `PressureObserver` (`gpu` source) | GPU pressure (where supported) |
| `'PressureObserver' in window` | Feature detect + fallback |
| `PerformanceObserver({ type: "long-animation-frame" })` | Cross-check (see exp-28) |
| `requestAnimationFrame` | Compositor stand-in |
| `Atomics.wait` (in workers) | Synthetic load generator |

## State machine

```
nominal  → fair    → serious        → critical
  │         │         │                │
  full      preview   preview ½ res    pause animation
  effects   effects   no background    drop background
            on        proxy            kill non-essentials
```

Transitions are debounced 1 s in each direction; the API itself fires
at `sampleInterval: 1000` ms.

## Synthetic load

Real machines rarely fire `serious` without doing real work. The page
spawns N workers (`navigator.hardwareConcurrency - 1`) that busy-loop
on `Atomics.wait` of an `Int32Array` for the requested duration. The
result is a few seconds of pegged CPU on demand, enough to make the
Pressure callback fire `fair` → `serious` reliably on most laptops.

## Compositor stand-in

A `requestAnimationFrame` loop that draws N rotating rectangles to a
canvas. Default N = 200. The policy layer modulates:

- `nominal`: full N, full-resolution canvas, all effects on.
- `fair`: N unchanged, effects toggled to "cheap".
- `serious`: N halved, canvas resolution halved (DPR-style downscale).
- `critical`: animation paused, banner shown.

Each transition is narrated in the UI ("dropped preview to 1280×720",
"paused background proxy", "resumed full-resolution") so the policy
is debuggable.

## UI

- Feature-detection banner if `PressureObserver` is missing.
- Live readout: current CPU state, current GPU state (where
  available), last transition time.
- History graph (last 60 s) of state-over-time, colour-coded.
- Load generator: "Burn 4 cores 30 s", "Burn until clicked again",
  "Pause".
- Compositor canvas with FPS counter, current N, current resolution.
- Policy log (rolling): each action the policy applied + reason.

## Success Criteria

1. With no synthetic load, state stays at `nominal` and the
   compositor runs at 60 fps.
2. Running the "Burn 4 cores 30 s" generator reliably transitions to
   `serious` within ~3 s on a typical laptop; compositor drops
   accordingly.
3. State returns to `nominal` within ~5 s after the load ends.
4. Browsers without `PressureObserver` show the fallback banner and
   do not error.

## Foot-guns

- `PressureObserver` only fires on user-activated pages; visibility
  changes can pause callbacks.
- macOS Chrome historically lags behind Linux/Windows in reporting
  GPU pressure.
- The state transitions are *advisory* — there is no hard guarantee
  the system is actually hot. Your policy needs hysteresis to avoid
  flapping.
- Synthetic load via `Atomics.wait` in workers does not engage the
  GPU; you'll need real WebGPU work to provoke GPU pressure.
- Reducing canvas resolution in response to pressure is correct;
  rendering at full DPR while in `critical` is not.
