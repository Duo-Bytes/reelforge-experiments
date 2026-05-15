/**
 * Rolling stats counters: fps, bitrate, queue depth.
 */

export class RollingAverage {
  private samples: { v: number; t: number }[] = [];
  constructor(private readonly windowMs: number) {}
  push(v: number): void {
    const now = performance.now();
    this.samples.push({ v, t: now });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.t < cutoff) {
      this.samples.shift();
    }
  }
  /** Returns the average value over the window. */
  avg(): number {
    if (this.samples.length === 0) return 0;
    let s = 0;
    for (const x of this.samples) s += x.v;
    return s / this.samples.length;
  }
  /** Returns the rate (sum of values per second) over the window. */
  rate(): number {
    if (this.samples.length === 0) return 0;
    let s = 0;
    for (const x of this.samples) s += x.v;
    return (s / this.windowMs) * 1000;
  }
}
