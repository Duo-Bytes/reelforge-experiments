// Minimal ASS / SSA subtitle parser + style/override extractor.
//
// Scope (deliberately small — this is a de-risk experiment, not libass):
//   - `[Script Info]`: PlayResX, PlayResY
//   - `[V4+ Styles]`: a Format header and any number of Style: rows
//   - `[Events]`: a Format header and Dialogue: rows
//   - Override codes inside Dialogue Text:
//        \an{1..9}        positioning (3x3 numpad)
//        \fad(in, out)    linear fade in/out, milliseconds
//        \c&HBBGGRR&      primary colour override (BGR, like SubStation)
//
// Anything else inside `{...}` is stripped from the rendered text.
// Drawing commands (`\p1`), \t() animations, vector clips and karaoke
// (`\k`, `\K`) are out of scope; production should use SubtitlesOctopus.

export type AssStyle = {
  name: string;
  fontName: string;
  fontSize: number;
  primaryColour: string;     // CSS rgba
  outline: number;
  shadow: number;
  alignment: number;          // 1..9 numpad
  marginV: number;
};

export type AssCue = {
  index: number;
  start: number;              // seconds
  end: number;
  layer: number;
  styleName: string;
  text: string;               // override codes stripped
  alignment: number;          // resolved (overrides win)
  fadeIn: number;             // ms
  fadeOut: number;            // ms
  colourOverride: string | null;
};

export type ParsedAss = {
  playResX: number;
  playResY: number;
  styles: Map<string, AssStyle>;
  cues: AssCue[];
};

export class AssParseError extends Error {}

function parseAssTime(s: string): number {
  // "0:00:01.50"  -> 1.5
  const m = s.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,3})$/);
  if (!m) throw new AssParseError(`Bad ASS time: "${s}"`);
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  // Note: ASS timestamps use centiseconds (1/100s), padded to two digits.
  const cs = parseInt(m[4].padEnd(2, "0").slice(0, 2), 10);
  return h * 3600 + mm * 60 + ss + cs / 100;
}

function bgrToCss(bgrHex: string): string {
  // Format: &HBBGGRR& or &HAABBGGRR&
  const m = bgrHex.match(/^&H([0-9A-Fa-f]{1,8})&?$/);
  if (!m) return "white";
  let hex = m[1].padStart(8, "0");
  // AABBGGRR. Alpha is "transparency" in ASS — 00=opaque, FF=transparent.
  const a = 255 - parseInt(hex.slice(0, 2), 16);
  const b = parseInt(hex.slice(2, 4), 16);
  const g = parseInt(hex.slice(4, 6), 16);
  const r = parseInt(hex.slice(6, 8), 16);
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

function splitFormatRow(formatLine: string): string[] {
  return formatLine.split(":").slice(1).join(":").split(",").map((s) => s.trim());
}

export function parseAss(text: string): ParsedAss {
  const lines = text.replace(/\r/g, "").split("\n");
  let section: string | null = null;
  let playResX = 1920;
  let playResY = 1080;
  const styles = new Map<string, AssStyle>();
  const cues: AssCue[] = [];

  let stylesFormat: string[] = [];
  let eventsFormat: string[] = [];
  let cueIdx = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const sect = line.match(/^\[(.+)\]$/);
    if (sect) {
      section = sect[1];
      continue;
    }
    if (section === "Script Info") {
      const [k, v] = line.split(":").map((s) => s.trim());
      if (k === "PlayResX") playResX = parseInt(v, 10) || playResX;
      else if (k === "PlayResY") playResY = parseInt(v, 10) || playResY;
      continue;
    }
    if (section === "V4+ Styles" || section === "V4 Styles") {
      if (line.startsWith("Format:")) {
        stylesFormat = splitFormatRow(line);
        continue;
      }
      if (line.startsWith("Style:")) {
        const vals = splitFormatRow(line);
        const get = (k: string) => vals[stylesFormat.indexOf(k)] ?? "";
        styles.set(get("Name"), {
          name: get("Name"),
          fontName: get("Fontname") || "sans-serif",
          fontSize: parseFloat(get("Fontsize")) || 40,
          primaryColour: bgrToCss(get("PrimaryColour")),
          outline: parseFloat(get("Outline")) || 0,
          shadow: parseFloat(get("Shadow")) || 0,
          alignment: parseInt(get("Alignment"), 10) || 2,
          marginV: parseInt(get("MarginV"), 10) || 0,
        });
      }
      continue;
    }
    if (section === "Events") {
      if (line.startsWith("Format:")) {
        eventsFormat = splitFormatRow(line);
        continue;
      }
      if (line.startsWith("Dialogue:")) {
        // Dialogue's last field (Text) may itself contain commas, so we
        // join everything past the last format-defined comma.
        const idxText = eventsFormat.indexOf("Text");
        const after = line.slice("Dialogue:".length).trim();
        const head = after.split(",");
        const fixed = head.slice(0, idxText);
        const textRaw = head.slice(idxText).join(",");
        const get = (k: string) => fixed[eventsFormat.indexOf(k)] ?? "";
        const styleName = get("Style");
        const baseStyle = styles.get(styleName);
        const baseAlign = baseStyle?.alignment ?? 2;

        const override = extractOverrides(textRaw);
        cues.push({
          index: cueIdx++,
          start: parseAssTime(get("Start")),
          end: parseAssTime(get("End")),
          layer: parseInt(get("Layer"), 10) || 0,
          styleName,
          text: override.text,
          alignment: override.alignment ?? baseAlign,
          fadeIn: override.fadeIn,
          fadeOut: override.fadeOut,
          colourOverride: override.colour,
        });
      }
    }
  }

  return { playResX, playResY, styles, cues };
}

type Overrides = {
  text: string;
  alignment: number | null;
  fadeIn: number;
  fadeOut: number;
  colour: string | null;
};

function extractOverrides(raw: string): Overrides {
  let alignment: number | null = null;
  let fadeIn = 0;
  let fadeOut = 0;
  let colour: string | null = null;

  // Strip override blocks, capturing tags we care about.
  const text = raw.replace(/\{([^}]*)\}/g, (_, body: string) => {
    const an = body.match(/\\an([1-9])/);
    if (an) alignment = parseInt(an[1], 10);
    const fad = body.match(/\\fad\((\d+),\s*(\d+)\)/);
    if (fad) {
      fadeIn = parseInt(fad[1], 10);
      fadeOut = parseInt(fad[2], 10);
    }
    const c = body.match(/\\c(&H[0-9A-Fa-f]+&)/);
    if (c) colour = bgrToCss(c[1]);
    return "";
  });

  return {
    // ASS uses \N for hard line breaks.
    text: text.replace(/\\N/g, "\n"),
    alignment,
    fadeIn,
    fadeOut,
    colour,
  };
}

/**
 * Alpha at time `t` for a cue with linear in/out fades. Returns 0..1.
 * Outside the cue interval the function returns 0.
 */
export function cueAlpha(cue: AssCue, t: number): number {
  if (t < cue.start || t >= cue.end) return 0;
  const fin = cue.fadeIn / 1000;
  const fout = cue.fadeOut / 1000;
  const inAlpha = fin > 0 ? Math.min(1, (t - cue.start) / fin) : 1;
  const outAlpha = fout > 0 ? Math.min(1, (cue.end - t) / fout) : 1;
  return Math.min(inAlpha, outAlpha);
}
