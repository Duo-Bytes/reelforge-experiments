/**
 * Synthetic audio (chirp) and filmstrip generators so the page is
 * interactive without user input.
 */

const SAMPLE_RATE = 48_000;

export async function synthesizeChirp(
  durationSec = 30,
  fStart = 50,
  fEnd = 4000,
): Promise<AudioBuffer> {
  const length = SAMPLE_RATE * durationSec;
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length,
    sampleRate: SAMPLE_RATE,
  });
  const osc = new OscillatorNode(ctx, { type: "sine", frequency: fStart });
  osc.frequency.setValueAtTime(fStart, 0);
  osc.frequency.exponentialRampToValueAtTime(fEnd, durationSec);
  const env = new GainNode(ctx, { gain: 0.7 });
  osc.connect(env).connect(ctx.destination);
  osc.start();
  return ctx.startRendering();
}

export type FilmstripFrame = {
  ts: number;
  bitmap: ImageBitmap;
};

/**
 * Synthetic filmstrip: a row of coloured-gradient ImageBitmaps. Used
 * when no video input is provided so the filmstrip lane is interactive.
 */
export async function synthesizeFilmstrip(
  count = 30,
  width = 160,
  height = 90,
): Promise<FilmstripFrame[]> {
  const out: FilmstripFrame[] = [];
  for (let i = 0; i < count; i += 1) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D unavailable");
    const hue = (i / count) * 360;
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, `hsl(${hue} 70% 30%)`);
    grad.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 60%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "12px monospace";
    ctx.fillText(`#${String(i).padStart(2, "0")}`, 8, 18);
    const bitmap = await createImageBitmap(canvas);
    out.push({ ts: i, bitmap });
  }
  return out;
}
