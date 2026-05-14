// Smart-cut scoring for exp-39.
//
// v1: stub transcript + simple text / audio / motion / novelty heuristics so
// the UI loop runs end-to-end. v2 wires exp-26 Whisper for real transcripts
// and a low-res WebCodecs decode for the motion signal.

export type Word = { t: number; w: string };

export type Transcript = {
  words: Word[];
  totalSec: number;
  audioEnergyCached?: number[];
  motionCached?: number[];
};

export type Weights = {
  text: number;
  audio: number;
  motion: number;
  novelty: number;
};

export type Candidate = {
  startSec: number;
  endSec: number;
  totalSec: number;
  summary: string;
  score: number;
  textScore: number;
  audioScore: number;
  motionScore: number;
  noveltyScore: number;
};

export async function decodeForAnalysis(file: File): Promise<{
  audioEnergy: number[];
  motion: number[];
  durationSec: number;
}> {
  const buf = await file.arrayBuffer();
  const tmp = new AudioContext();
  const decoded = await tmp.decodeAudioData(buf.slice(0));
  await tmp.close();

  const sr = decoded.sampleRate;
  const windowSec = 0.5;
  const windowSamples = Math.round(sr * windowSec);
  const ch0 = decoded.getChannelData(0);
  const energy: number[] = [];
  for (let i = 0; i + windowSamples <= ch0.length; i += windowSamples) {
    let s = 0;
    for (let j = i; j < i + windowSamples; j++) s += ch0[j] * ch0[j];
    energy.push(Math.sqrt(s / windowSamples));
  }
  // motion stub: pseudo-random from a hash of duration so the UI shows
  // something coherent. v2: real low-res mean-frame-difference.
  const motion: number[] = energy.map((_, i) => {
    const seed = Math.sin(i * 0.317 + decoded.duration) * 43758.5453;
    return Math.abs(seed - Math.floor(seed));
  });
  return { audioEnergy: zscoreNormalize(energy), motion, durationSec: decoded.duration };
}

export function fakeTranscript(durationSec: number): Transcript {
  // Sprinkle "marker words" so the text scorer finds something to lift on.
  const filler = ["uh", "so", "I", "think", "we", "should", "consider"];
  const beats = [
    "the one thing to remember is",
    "let me ask you a question",
    "here's what nobody talks about",
    "the surprising number is",
    "this is the key insight",
  ];
  const words: Word[] = [];
  let t = 0;
  while (t < durationSec) {
    if (Math.random() < 0.02) {
      const phrase = beats[Math.floor(Math.random() * beats.length)];
      for (const w of phrase.split(" ")) {
        words.push({ t, w });
        t += 0.18;
      }
    } else {
      words.push({ t, w: filler[Math.floor(Math.random() * filler.length)] });
      t += 0.25;
    }
  }
  return { words, totalSec: durationSec };
}

export function scoreCandidates(
  transcript: Transcript,
  audioEnergy: number[],
  motion: number[],
  weights: Weights,
): Candidate[] {
  const windowSec = 60;
  const stepSec = 20;
  transcript.audioEnergyCached = audioEnergy;
  transcript.motionCached = motion;

  const totalSec = transcript.totalSec;
  const out: Candidate[] = [];
  for (let start = 0; start + windowSec <= totalSec; start += stepSec) {
    const end = start + windowSec;
    const wordsInWindow = transcript.words.filter((w) => w.t >= start && w.t < end);
    const textScore = computeTextScore(wordsInWindow);
    const audioScore = avgRange(audioEnergy, start / totalSec, end / totalSec);
    const motionScore = avgRange(motion, start / totalSec, end / totalSec);
    const noveltyScore = computeNovelty(wordsInWindow, transcript.words);
    const score =
      weights.text * textScore +
      weights.audio * audioScore +
      weights.motion * motionScore +
      weights.novelty * noveltyScore;
    out.push({
      startSec: start,
      endSec: end,
      totalSec,
      score,
      textScore,
      audioScore,
      motionScore,
      noveltyScore,
      summary: summarize(wordsInWindow),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function computeTextScore(words: Word[]): number {
  const signals = [
    "the one thing",
    "let me ask",
    "nobody talks",
    "key insight",
    "surprising",
    "question",
  ];
  const joined = words.map((w) => w.w).join(" ").toLowerCase();
  let score = 0;
  for (const s of signals) if (joined.includes(s)) score += 1;
  return Math.min(2.5, score);
}

function computeNovelty(window: Word[], all: Word[]): number {
  if (window.length === 0) return 0;
  const windowSet = new Set(window.map((w) => w.w));
  const allFreq = new Map<string, number>();
  for (const w of all) allFreq.set(w.w, (allFreq.get(w.w) ?? 0) + 1);
  let unique = 0;
  for (const w of windowSet) {
    if ((allFreq.get(w) ?? 0) <= window.length * 2) unique++;
  }
  return unique / Math.max(1, windowSet.size);
}

function avgRange(arr: number[], frac0: number, frac1: number): number {
  if (arr.length === 0) return 0;
  const i0 = Math.floor(frac0 * arr.length);
  const i1 = Math.max(i0 + 1, Math.floor(frac1 * arr.length));
  let s = 0;
  let n = 0;
  for (let i = i0; i < i1 && i < arr.length; i++) {
    s += arr[i];
    n++;
  }
  return n ? s / n : 0;
}

function summarize(words: Word[]): string {
  if (words.length === 0) return "(empty)";
  const text = words.map((w) => w.w).join(" ");
  return text.length > 110 ? text.slice(0, 107) + "…" : text;
}

function zscoreNormalize(xs: number[]): number[] {
  if (xs.length === 0) return xs;
  let mean = 0;
  for (const v of xs) mean += v;
  mean /= xs.length;
  let variance = 0;
  for (const v of xs) variance += (v - mean) * (v - mean);
  variance /= Math.max(1, xs.length - 1);
  const std = Math.sqrt(variance) || 1;
  // normalize to roughly [0, 1] for plotting + scoring
  return xs.map((v) => Math.max(0, Math.min(1, 0.5 + (v - mean) / (3 * std))));
}
