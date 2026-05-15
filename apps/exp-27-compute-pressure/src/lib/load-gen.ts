/**
 * Synthetic CPU load: spawn workers that each burn one core for the
 * requested duration. Provoking `serious` from PressureObserver on a
 * typical laptop is otherwise unreliable.
 */

export type LoadHandle = {
  stop: () => void;
};

export function startBurn(durationMs: number, cores?: number): LoadHandle {
  const numCores = Math.max(
    1,
    cores ?? Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
  );
  const workers: Worker[] = [];
  for (let i = 0; i < numCores; i += 1) {
    const w = new Worker(
      new URL("../workers/burn.worker.ts", import.meta.url),
      { type: "module" },
    );
    w.postMessage({ durationMs });
    workers.push(w);
  }
  let stopped = false;
  const timer = window.setTimeout(() => {
    if (!stopped) {
      stopped = true;
      for (const w of workers) w.terminate();
    }
  }, durationMs + 100);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(timer);
      for (const w of workers) w.terminate();
    },
  };
}
