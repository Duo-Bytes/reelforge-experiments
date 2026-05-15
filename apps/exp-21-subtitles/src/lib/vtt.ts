// Tiny WebVTT parser. Handles the subset we need for the demo:
//   - header `WEBVTT` line
//   - cue blocks separated by blank lines
//   - `start --> end` timestamps in `HH:MM:SS.mmm` or `MM:SS.mmm`
//   - inline settings on the cue line (`align:start`, `line:5%`, etc.)
//   - plain payload (no inner spans / CSS classes)

export type VttCue = {
  index: number;
  start: number;      // seconds
  end: number;        // seconds
  text: string;
  align: "start" | "center" | "end";
  /** As a percentage 0..100, or null = default placement (near bottom). */
  linePct: number | null;
};

export class VttParseError extends Error {}

const TS = /(\d{1,2}:)?\d{1,2}:\d{1,2}\.\d{1,3}/;

function parseTimestamp(s: string): number {
  const parts = s.split(":");
  let hours = 0, minutes = 0, seconds = 0;
  if (parts.length === 3) {
    hours = parseInt(parts[0], 10);
    minutes = parseInt(parts[1], 10);
    seconds = parseFloat(parts[2]);
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0], 10);
    seconds = parseFloat(parts[1]);
  } else {
    throw new VttParseError(`Invalid timestamp: ${s}`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

export function parseVtt(text: string): VttCue[] {
  const lines = text.replace(/\r/g, "").split("\n");
  if (!lines[0].startsWith("WEBVTT")) {
    throw new VttParseError("Missing WEBVTT header");
  }
  const cues: VttCue[] = [];
  let i = 1;
  let idx = 0;
  while (i < lines.length) {
    // Skip blank lines and notes.
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;
    if (lines[i].startsWith("NOTE")) {
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }
    // Optional cue identifier line: a line without `-->`.
    if (!lines[i].includes("-->")) {
      // Skip the identifier — we don't need it.
      i++;
      if (i >= lines.length) break;
    }
    const timingLine = lines[i];
    const m = timingLine.match(
      new RegExp(`(${TS.source})\\s*-->\\s*(${TS.source})(.*)$`),
    );
    if (!m) throw new VttParseError(`Bad timing line: "${timingLine}"`);
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[3]);
    const settings = m[5] ?? "";
    let align: VttCue["align"] = "center";
    let linePct: number | null = null;
    for (const tok of settings.trim().split(/\s+/)) {
      const eq = tok.indexOf(":");
      if (eq <= 0) continue;
      const key = tok.slice(0, eq);
      const val = tok.slice(eq + 1);
      if (key === "align") {
        if (val === "start" || val === "end" || val === "center") align = val;
      } else if (key === "line") {
        const pct = parseFloat(val);
        if (Number.isFinite(pct)) linePct = pct;
      }
    }
    i++;
    const payload: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      payload.push(lines[i]);
      i++;
    }
    cues.push({
      index: idx++,
      start,
      end,
      text: payload.join("\n"),
      align,
      linePct,
    });
  }
  return cues;
}

export function activeCues<T extends { start: number; end: number }>(
  cues: T[],
  t: number,
): T[] {
  return cues.filter((c) => t >= c.start && t < c.end);
}
