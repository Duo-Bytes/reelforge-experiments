/// <reference lib="webworker" />

// ASS renderer worker.
//
// Receives the parsed ASS document once (per swap) and a (playhead, width,
// height) tuple per frame. Draws active cues to an OffscreenCanvas using
// Canvas2D, transfers the result as an ImageBitmap, posts it back to the
// main thread.
//
// We keep the OffscreenCanvas alive for the lifetime of the worker so we
// only pay the GPU upload cost on resize, not per frame.

import type { ParsedAss, AssCue } from "../lib/ass";
import { cueAlpha } from "../lib/ass";

declare const self: DedicatedWorkerGlobalScope;

type FromMain =
  | { kind: "init"; doc: ParsedAss }
  | { kind: "render"; t: number; width: number; height: number; reqId: number }
  | { kind: "dispose" };

type ToMain =
  | { kind: "frame"; reqId: number; bitmap: ImageBitmap; renderMs: number }
  | { kind: "ready" };

let doc: ParsedAss | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function ensureCanvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    const c = canvas.getContext("2d");
    if (!c) throw new Error("OffscreenCanvas 2d unavailable in worker");
    ctx = c;
  }
  return ctx!;
}

// ASS \an code -> {textAlign, vertical anchor, x fraction, y fraction}
// The numpad layout:   7 8 9
//                      4 5 6
//                      1 2 3
function anchor(an: number): {
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
  xFrac: number;
  yFrac: number;
} {
  const col = ((an - 1) % 3);            // 0=left, 1=center, 2=right
  const row = Math.floor((an - 1) / 3);  // 0=bottom, 1=middle, 2=top
  const align = (["left", "center", "right"] as CanvasTextAlign[])[col];
  const baseline =
    row === 0 ? "bottom" : row === 1 ? "middle" : "top";
  const xFrac = col === 0 ? 0.04 : col === 1 ? 0.5 : 0.96;
  const yFrac = row === 0 ? 0.94 : row === 1 ? 0.5 : 0.06;
  return { align, baseline, xFrac, yFrac };
}

function drawCue(
  c: OffscreenCanvasRenderingContext2D,
  cue: AssCue,
  t: number,
  width: number,
  height: number,
  parsed: ParsedAss,
): void {
  const a = cueAlpha(cue, t);
  if (a <= 0) return;
  const style = parsed.styles.get(cue.styleName);
  const fontPx = style ? style.fontSize * (height / parsed.playResY) : 36;
  const colour = cue.colourOverride ?? style?.primaryColour ?? "white";
  const outline = (style?.outline ?? 1.5) * (height / parsed.playResY);
  const { align, baseline, xFrac, yFrac } = anchor(cue.alignment);

  c.save();
  c.globalAlpha = a;
  c.font = `${fontPx}px ${style?.fontName ?? "sans-serif"}`;
  c.textAlign = align;
  c.textBaseline = baseline;
  c.lineJoin = "round";

  const x = width * xFrac;
  const y = height * yFrac;
  const lines = cue.text.split("\n");
  const lineHeight = fontPx * 1.15;
  // Stack vertically around the anchor's vertical baseline.
  const startOffset =
    baseline === "top"
      ? 0
      : baseline === "middle"
        ? -((lines.length - 1) * lineHeight) / 2
        : -((lines.length - 1) * lineHeight);

  for (let i = 0; i < lines.length; i++) {
    const ly = y + startOffset + i * lineHeight;
    // Outline first, then fill — cheap stand-in for the ASS BorderStyle=1
    // "outline + drop shadow" path.
    if (outline > 0) {
      c.lineWidth = outline * 2;
      c.strokeStyle = "rgba(0, 0, 0, 0.95)";
      c.strokeText(lines[i], x, ly);
    }
    c.fillStyle = colour;
    c.fillText(lines[i], x, ly);
  }
  c.restore();
}

self.onmessage = (e: MessageEvent<FromMain>) => {
  const msg = e.data;
  if (msg.kind === "init") {
    doc = msg.doc;
    const out: ToMain = { kind: "ready" };
    self.postMessage(out);
    return;
  }
  if (msg.kind === "dispose") {
    doc = null;
    canvas = null;
    ctx = null;
    return;
  }
  if (msg.kind === "render") {
    if (!doc) return;
    const t0 = performance.now();
    const c = ensureCanvas(msg.width, msg.height);
    c.clearRect(0, 0, msg.width, msg.height);
    for (const cue of doc.cues) {
      if (msg.t >= cue.start - cue.fadeIn / 1000 && msg.t < cue.end + cue.fadeOut / 1000) {
        drawCue(c, cue, msg.t, msg.width, msg.height, doc);
      }
    }
    // transferToImageBitmap empties the canvas, so we re-draw every frame.
    const bitmap = canvas!.transferToImageBitmap();
    const renderMs = performance.now() - t0;
    const out: ToMain = { kind: "frame", reqId: msg.reqId, bitmap, renderMs };
    self.postMessage(out, [bitmap]);
  }
};
