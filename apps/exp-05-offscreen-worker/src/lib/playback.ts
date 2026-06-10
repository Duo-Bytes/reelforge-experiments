/**
 * Decide which video frame the playback loop should request this tick.
 *
 * The render loop ticks far faster than the decoder can serve frames. Two gates
 * stop it from flooding the decode worker:
 *  - backpressure: skip while a decode is still outstanding (`pendingDecode`).
 *  - dedup: skip while the playhead is still inside the frame we last requested.
 *
 * Returns the integer frame index to request, or null to request nothing.
 */
export function nextFrameIndex(
  playheadUs: number,
  stepUs: number,
  lastFrameIndex: number,
  pendingDecode: boolean,
): number | null {
  if (pendingDecode) return null;
  const step = stepUs > 0 ? stepUs : Math.round(1_000_000 / 30);
  const idx = Math.floor(playheadUs / step);
  if (idx === lastFrameIndex) return null;
  return idx;
}
