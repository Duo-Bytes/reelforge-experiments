// LoAF observer plumbing.
//
// The PerformanceLongAnimationFrameTiming entry isn't in the standard
// dom lib yet, so we declare the shape we actually read. Anything we
// haven't observed is `unknown`.

export type LoAFScript = {
  name: string;
  duration: number;
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  sourceCharPosition: number;
  startTime: number;
  forcedStyleAndLayoutDuration: number;
};

export type LoAFEntry = {
  name: string;
  entryType: "long-animation-frame";
  startTime: number;
  duration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  firstUIEventTimestamp: number;
  blockingDuration: number;
  scripts: LoAFScript[];
};

export type LoAFStats = {
  count: number;
  median: number;
  p95: number;
  max: number;
  totalForcedLayout: number;
};

export function isLoAFSupported(): boolean {
  if (typeof PerformanceObserver === "undefined") return false;
  const types = PerformanceObserver.supportedEntryTypes;
  return Array.isArray(types) && types.includes("long-animation-frame");
}

// `entry.scripts[]` is plain-object accessible — but the PerformanceEntry
// `toJSON()` only returns the top-level fields. We snapshot manually to
// keep `scripts[]` in the rolling buffer.
export function snapshotEntry(raw: PerformanceEntry): LoAFEntry {
  // The runtime object carries the extra fields even though the type
  // doesn't declare them. We narrow once at the boundary.
  const r = raw as PerformanceEntry & {
    renderStart?: number;
    styleAndLayoutStart?: number;
    firstUIEventTimestamp?: number;
    blockingDuration?: number;
    scripts?: Array<Record<string, unknown>>;
  };
  const scripts: LoAFScript[] = Array.isArray(r.scripts)
    ? r.scripts.map((s) => ({
        name: String(s.name ?? ""),
        duration: Number(s.duration ?? 0),
        invoker: String(s.invoker ?? ""),
        invokerType: String(s.invokerType ?? ""),
        sourceURL: String(s.sourceURL ?? ""),
        sourceFunctionName: String(s.sourceFunctionName ?? ""),
        sourceCharPosition: Number(s.sourceCharPosition ?? -1),
        startTime: Number(s.startTime ?? 0),
        forcedStyleAndLayoutDuration: Number(
          s.forcedStyleAndLayoutDuration ?? 0,
        ),
      }))
    : [];
  return {
    name: raw.name,
    entryType: "long-animation-frame",
    startTime: raw.startTime,
    duration: raw.duration,
    renderStart: r.renderStart ?? 0,
    styleAndLayoutStart: r.styleAndLayoutStart ?? 0,
    firstUIEventTimestamp: r.firstUIEventTimestamp ?? 0,
    blockingDuration: r.blockingDuration ?? 0,
    scripts,
  };
}

export function computeStats(entries: LoAFEntry[]): LoAFStats {
  if (entries.length === 0) {
    return { count: 0, median: 0, p95: 0, max: 0, totalForcedLayout: 0 };
  }
  const sorted = entries.map((e) => e.duration).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const max = sorted[sorted.length - 1];
  let totalForced = 0;
  for (const e of entries) {
    for (const s of e.scripts) totalForced += s.forcedStyleAndLayoutDuration;
  }
  return { count: entries.length, median: med, p95, max, totalForcedLayout: totalForced };
}

// Aggregate scripts by (sourceURL + sourceFunctionName) for the
// attribution table. Empty origins are kept as a separate "(unattributed)"
// bucket — the docs explicitly call out that cross-origin scripts elide.
export function topScripts(
  entries: LoAFEntry[],
  limit = 8,
): Array<{ key: string; total: number; count: number; forced: number }> {
  const acc = new Map<string, { total: number; count: number; forced: number }>();
  for (const e of entries) {
    for (const s of e.scripts) {
      const url = s.sourceURL || "(unattributed)";
      const fn = s.sourceFunctionName || s.invoker || "(anonymous)";
      const key = `${fn} @ ${url}`;
      const slot = acc.get(key) ?? { total: 0, count: 0, forced: 0 };
      slot.total += s.duration;
      slot.count += 1;
      slot.forced += s.forcedStyleAndLayoutDuration;
      acc.set(key, slot);
    }
  }
  return [...acc.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}
