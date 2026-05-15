# exp-28 · Long Animation Frames Performance Budget

## Purpose

Subscribe to `PerformanceObserver({ type: "long-animation-frame" })` for
the full life of a page and prove the dashboard (a) catches each kind
of frame-stealing work, (b) attributes it back to a script, and (c)
exports a JSON report that's good enough to gate a CI run on.

Long Tasks only measures script time on the main thread. LoAF wraps
the entire frame including style/layout/paint, which is the only
measurement that maps cleanly to "did the user see a stutter?". This
experiment is the harness the rest of the app gets benchmarked under.

## What's here

- `src/lib/loaf.ts` — feature detect, manual entry snapshot (because
  `entry.toJSON()` drops `scripts[]`), rolling-window stats, per-script
  attribution grouping.
- `src/app/page.tsx` — dashboard with median/p95/max/count, top-scripts
  table with forced-layout column, four load generators
  (Block 100 ms / Layout thrash / React state churn / Idle), a
  pass/fail banner, and a JSON download button.

## How to run

```
pnpm --filter exp-28-loaf-budget dev
```

Open the page in Chrome 123+. Click a generator and watch the gate
flip. The observer disconnects automatically on unmount.

## What to look for

- Idle: median LoAF stays well below 50 ms on a typical laptop.
- Block 100 ms: gate flips red within ~2 s; "Block" surfaces in the
  attribution table.
- Layout thrash: total script time can be tiny while
  `forcedStyleAndLayoutDuration` dominates — the dedicated column
  exists exactly for this case.
- React state churn: many short frames sum into the rolling stats; the
  React reconciler shows up as the top contributor.
- Stop: the banner returns to green within ~3 s.

## Success bar

1. Median LoAF in Idle is &lt; 50 ms.
2. Each generator produces a visible spike in the distribution and a
   matching row in the attribution table within 1 s.
3. The gate flips red within 2 s of triggering the 100 ms blocker.
4. The JSON report's `entries[i].scripts[]` carries non-empty
   `sourceURL` or `invoker` fields for first-party scripts, and clearly
   documents the empty (cross-origin) case.

## Known foot-guns

- Feature-gate everything. Firefox/Safari don't ship LoAF yet (as of
  mid-2026). The app shows an amber banner when the entry type is
  unavailable rather than throwing.
- `entry.scripts[]` is empty for cross-origin scripts without a
  `Timing-Allow-Origin` header. Don't treat empty as "no work".
- The observer fires *after* the frame. Never try to react to a slow
  frame synchronously — schedule on the next macrotask.
- Median over a too-small window (&lt; 10 s) flickers near the gate. We
  use a 10 s gate window with a 30 s display window.
