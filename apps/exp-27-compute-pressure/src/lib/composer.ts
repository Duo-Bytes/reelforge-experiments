/**
 * Compositor stand-in: a requestAnimationFrame loop drawing N rotating
 * rectangles to a canvas. The policy layer modulates rectCount,
 * resolutionScale, effectsLevel, paused.
 */

import type { CompositorQuality } from "./policy";

export type Composer = {
  setQuality: (q: CompositorQuality) => void;
  stop: () => void;
  getFps: () => number;
  getRectCount: () => number;
  getResolution: () => { w: number; h: number };
};

export function createComposer(canvas: HTMLCanvasElement): Composer {
  let quality: CompositorQuality = {
    rectCount: 200,
    resolutionScale: 1,
    effectsLevel: "full",
    paused: false,
    reason: "init",
  };
  let raf = 0;
  let lastFrameMs = performance.now();
  let fps = 60;
  let stopped = false;

  function tick(now: number) {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    const dt = now - lastFrameMs;
    lastFrameMs = now;
    if (dt > 0) {
      const inst = 1000 / dt;
      fps = fps * 0.92 + inst * 0.08;
    }
    if (quality.paused) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#ef4444";
        ctx.font = "16px monospace";
        ctx.fillText("PAUSED — system critical", 20, 30);
      }
      return;
    }
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const scale = quality.resolutionScale;
    const targetW = Math.round(cssW * scale);
    const targetH = Math.round(cssH * scale);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const t = now * 0.001;
    for (let i = 0; i < quality.rectCount; i += 1) {
      const cx = ((i * 53) % canvas.width) + 8;
      const cy = ((i * 71) % canvas.height) + 8;
      const angle = t + i * 0.05;
      const size = 24;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      const hue = (i * 11 + t * 30) % 360;
      ctx.fillStyle =
        quality.effectsLevel === "full"
          ? `hsla(${hue}, 70%, 55%, 0.8)`
          : quality.effectsLevel === "cheap"
            ? `hsl(${hue}, 50%, 50%)`
            : "#888";
      ctx.fillRect(-size / 2, -size / 2, size, size);
      if (quality.effectsLevel === "full") {
        ctx.strokeStyle = `hsla(${(hue + 60) % 360}, 70%, 70%, 0.6)`;
        ctx.lineWidth = 2;
        ctx.strokeRect(-size / 2, -size / 2, size, size);
      }
      ctx.restore();
    }
  }

  raf = requestAnimationFrame(tick);

  return {
    setQuality(q) {
      quality = q;
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
    },
    getFps() {
      return fps;
    },
    getRectCount() {
      return quality.rectCount;
    },
    getResolution() {
      return { w: canvas.width, h: canvas.height };
    },
  };
}
