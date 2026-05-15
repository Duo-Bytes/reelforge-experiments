/**
 * Minimal types for PressureObserver (Compute Pressure API).
 *
 * The API is not yet in the standard DOM lib in our TS version; we
 * declare exactly what we use.
 */

export type PressureSource = "cpu" | "gpu";
export type PressureRecordState = "nominal" | "fair" | "serious" | "critical";

export type PressureRecord = {
  source: PressureSource;
  state: PressureRecordState;
  time: number;
};

export type PressureObserverCallback = (records: PressureRecord[]) => void;

export type PressureObserverOptions = {
  sampleInterval?: number;
};

export type PressureObserverCtor = new (
  callback: PressureObserverCallback,
  options?: PressureObserverOptions,
) => {
  observe: (source: PressureSource) => Promise<void>;
  unobserve: (source: PressureSource) => void;
  disconnect: () => void;
};

export function getPressureObserver(): PressureObserverCtor | null {
  const ctor = (
    globalThis as unknown as { PressureObserver?: PressureObserverCtor }
  ).PressureObserver;
  return ctor ?? null;
}
