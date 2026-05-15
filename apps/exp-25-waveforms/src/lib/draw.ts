/**
 * Canvas draw helpers for the waveform + filmstrip.
 */

import type { PeakLod } from "./peak-format";
import type { FilmstripFrame } from "./synth";

export type ViewState = {
  /** Sample offset of the left edge of the viewport. */
  startSample: number;
  /** Samples per pixel. */
  samplesPerPixel: number;
};

export function drawWaveform(
  canvas: HTMLCanvasElement,
  lod: PeakLod,
  view: ViewState,
  sampleCount: number,
): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  const t0 = performance.now();
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#111";
  ctx.globalAlpha = 0.06;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#10b981";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const mid = height / 2;
  const samplesPerCol = view.samplesPerPixel;
  for (let x = 0; x < width; x += 1) {
    const sampleStart = view.startSample + x * samplesPerCol;
    if (sampleStart >= sampleCount) break;
    const binStart = Math.floor(sampleStart / lod.binSize);
    const binEnd = Math.min(
      lod.binCount - 1,
      Math.floor((sampleStart + samplesPerCol) / lod.binSize),
    );
    let mn = 1;
    let mx = -1;
    for (let b = binStart; b <= binEnd; b += 1) {
      const v0 = lod.data[b * 2]! / 32767;
      const v1 = lod.data[b * 2 + 1]! / 32767;
      if (v0 < mn) mn = v0;
      if (v1 > mx) mx = v1;
    }
    if (mn === 1 && mx === -1) continue;
    const y0 = mid - mx * (mid - 1);
    const y1 = mid - mn * (mid - 1);
    ctx.moveTo(x + 0.5, y0);
    ctx.lineTo(x + 0.5, y1 + 0.5);
  }
  ctx.stroke();
  return performance.now() - t0;
}

export function drawFilmstrip(
  canvas: HTMLCanvasElement,
  frames: FilmstripFrame[],
  thumbWidth: number,
  thumbHeight: number,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = frames.length * thumbWidth;
  const height = thumbHeight;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  for (let i = 0; i < frames.length; i += 1) {
    ctx.drawImage(frames[i]!.bitmap, i * thumbWidth, 0, thumbWidth, thumbHeight);
  }
}
