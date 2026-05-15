/**
 * Adaptive-quality state machine driven by PressureObserver state.
 *
 *   nominal  ─ fair ─ serious ─ critical
 *
 * Transitions are debounced (1 s in each direction) to avoid flapping
 * when the OS is right at the edge of a state.
 */

export type PressureState = "nominal" | "fair" | "serious" | "critical";

export type CompositorQuality = {
  rectCount: number;
  resolutionScale: number; // 1 = full, 0.5 = half each axis
  effectsLevel: "full" | "cheap" | "off";
  paused: boolean;
  /** Human-readable policy explanation for the UI log. */
  reason: string;
};

const BASE_RECT_COUNT = 200;

export function qualityForState(state: PressureState): CompositorQuality {
  switch (state) {
    case "nominal":
      return {
        rectCount: BASE_RECT_COUNT,
        resolutionScale: 1,
        effectsLevel: "full",
        paused: false,
        reason: "system nominal — full quality preview, full effects",
      };
    case "fair":
      return {
        rectCount: BASE_RECT_COUNT,
        resolutionScale: 1,
        effectsLevel: "cheap",
        paused: false,
        reason: "fair — keep N, switch effects to cheap variants",
      };
    case "serious":
      return {
        rectCount: Math.floor(BASE_RECT_COUNT / 2),
        resolutionScale: 0.5,
        effectsLevel: "off",
        paused: false,
        reason:
          "serious — preview dropped to 1280×720, halved rect count, paused background proxy",
      };
    case "critical":
      return {
        rectCount: 0,
        resolutionScale: 0.5,
        effectsLevel: "off",
        paused: true,
        reason: "critical — animation paused, all non-essentials killed",
      };
  }
}

const DEBOUNCE_MS = 1000;

export function createDebouncedTransition(
  onChange: (state: PressureState) => void,
): (proposed: PressureState) => void {
  let current: PressureState | null = null;
  let pending: { state: PressureState; at: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (proposed: PressureState) => {
    if (current === proposed) {
      pending = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return;
    }
    if (!pending || pending.state !== proposed) {
      pending = { state: proposed, at: Date.now() };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (pending) {
          current = pending.state;
          onChange(current);
          pending = null;
          timer = null;
        }
      }, DEBOUNCE_MS);
    }
  };
}
