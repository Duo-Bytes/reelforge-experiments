# exp-27 · Compute-Pressure Adaptive Quality

## Purpose

Use `PressureObserver` (CPU + GPU sources) to drive a compositor
stand-in: drop preview resolution, halve the rendered element count,
or pause animation entirely when the system enters `serious` /
`critical`. Survives a 30-min stress test in theory.

## State machine

```
nominal  ─ fair ─ serious  ─ critical
 full      cheap   half       paused
```

Transitions debounced 1 s. State is colour-coded in the 60-s history
graph.

## File map

```
src/app/page.tsx          Compositor canvas, controls, history graph
src/lib/policy.ts         State machine + transition rules
src/lib/load-gen.ts       Worker-based synthetic load generator
src/lib/composer.ts       rAF-driven rectangle compositor
src/workers/burn.worker.ts  Atomics.wait busy-loop
```

## What this shows

- `PressureObserver` subscription on `cpu` and (if available) `gpu`.
- Feature-detect banner if the API is missing.
- Synthetic load generator that spawns `hardwareConcurrency - 1`
  workers and burns CPU for a configurable duration. (Necessary to
  reliably provoke `serious` on a typical laptop.)
- Compositor stand-in: 200 rotating rectangles on a canvas. The
  policy layer modulates count + resolution + frame rate per state.
- Policy log narrating each transition ("dropped preview to
  1280×720", "paused background proxy", "resumed full-resolution").

## Running

```
pnpm --filter exp-27-compute-pressure dev
```

The page auto-starts the observer on load. Click "Burn 4 cores 30 s"
to drive the state into `serious`.

## Success criteria

1. No synthetic load → state stays at `nominal`, compositor at 60 fps.
2. Burn → transitions to `serious` within ~3 s.
3. After burn ends → returns to `nominal` within ~5 s.
4. Browsers without `PressureObserver` show a fallback banner.

## Foot-guns

- `PressureObserver` only fires on user-activated, visible pages.
- macOS Chrome historically lags on GPU pressure reporting.
- Synthetic CPU load does not engage the GPU; provoking GPU
  pressure requires real WebGPU work.
- The API is *advisory* — your policy needs hysteresis to avoid
  flapping.
