// Smart-cut scoring for exp-39.
//
// Real signals: word-level transcript from on-device Whisper (see
// workers/transcribe.worker.ts), audio RMS energy, and mean-frame-
// difference motion sampled from the decoded video. All scoring runs
// locally; nothing is uploaded.

import { resampleToMono } from "@reelforge/audio";

const TARGET_RATE = 16000;

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

/** Decode audio → 0.5 s RMS energy windows + 16 kHz mono PCM for ASR. */
export async function decodeForAnalysis(file: File): Promise<{
  audioEnergy: number[];
  pcm16k: Float32Array;
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

  const pcm16k = await resampleToMono(decoded, TARGET_RATE);
  return {
    audioEnergy: zscoreNormalize(energy),
    pcm16k,
    durationSec: decoded.duration,
  };
}

/**
 * Real motion signal: mean absolute luma difference between consecutive
 * sampled frames, one sample per audio-energy window. Video files only;
 * audio-only inputs return a flat zero array so motion contributes
 * nothing rather than noise.
 */
export async function computeMotion(
  file: File,
  durationSec: number,
  samples: number,
): Promise<number[]> {
  if (!file.type.startsWith("video/") || samples <= 0) {
    return new Array(samples).fill(0);
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.src = url;

  const W = 64;
  const H = 36;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const seek = (t: number) =>
    new Promise<void>((resolve, reject) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      const onErr = () => {
        video.removeEventListener("error", onErr);
        reject(new Error("video seek failed"));
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onErr, { once: true });
      video.currentTime = Math.min(t, Math.max(0, durationSec - 0.05));
    });

  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("video load failed")), {
        once: true,
      });
    });

    const out: number[] = [];
    let prev: Uint8ClampedArray | null = null;
    for (let i = 0; i < samples; i++) {
      const t = (i + 0.5) * (durationSec / samples);
      await seek(t);
      if (!ctx) break;
      ctx.drawImage(video, 0, 0, W, H);
      const cur = ctx.getImageData(0, 0, W, H).data;
      if (prev) {
        let diff = 0;
        for (let p = 0; p < cur.length; p += 4) {
          const lc = 0.299 * cur[p] + 0.587 * cur[p + 1] + 0.114 * cur[p + 2];
          const lp = 0.299 * prev[p] + 0.587 * prev[p + 1] + 0.114 * prev[p + 2];
          diff += Math.abs(lc - lp);
        }
        out.push(diff / (cur.length / 4) / 255);
      } else {
        out.push(0);
      }
      prev = cur.slice(0);
    }
    return zscoreNormalize(out);
  } catch {
    return new Array(samples).fill(0);
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
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

// Generic engagement signals that survive real ASR output (no reliance on
// scripted marker phrases): hook phrases, question/curiosity words, numbers,
// superlatives, and a mild reward for speech density.
const HOOK_PHRASES = [
  "the thing is",
  "here's the",
  "what nobody",
  "the key",
  "the secret",
  "the truth",
  "let me",
  "i'll show you",
  "you won't believe",
  "the best",
  "the worst",
  "the biggest",
];
const CURIOSITY_WORDS = new Set([
  "why",
  "how",
  "what",
  "secret",
  "mistake",
  "surprising",
  "never",
  "always",
  "best",
  "worst",
  "first",
  "most",
  "huge",
  "crazy",
  "actually",
]);

function computeTextScore(words: Word[]): number {
  if (words.length === 0) return 0;
  const joined = words.map((w) => w.w.toLowerCase()).join(" ");
  let score = 0;
  for (const p of HOOK_PHRASES) if (joined.includes(p)) score += 0.6;
  let curiosity = 0;
  let numbers = 0;
  for (const { w } of words) {
    const t = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (CURIOSITY_WORDS.has(t)) curiosity += 1;
    if (/\d/.test(w)) numbers += 1;
  }
  score += Math.min(1.2, curiosity * 0.15);
  score += Math.min(0.6, numbers * 0.2);
  // Mild density reward: a window packed with speech beats near-silence.
  score += Math.min(0.6, words.length / 120);
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
