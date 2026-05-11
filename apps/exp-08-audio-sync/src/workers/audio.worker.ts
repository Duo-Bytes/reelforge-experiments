/// <reference lib="webworker" />

import {
  Input,
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  type InputAudioTrack,
  type EncodedPacket,
} from "mediabunny";
import { ringWrite, resetRing } from "../lib/ringBuffer";

type StartMsg = {
  type: "START";
  file: File;
  sab: SharedArrayBuffer;
  startUs?: number;
};
type StopMsg = { type: "STOP" };
type InMsg = StartMsg | StopMsg;

let stop = false;
let info: {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  durationSec: number;
} | null = null;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "STOP") {
      stop = true;
      return;
    }
    if (e.data.type !== "START") return;
    stop = false;
    resetRing(e.data.sab);
    await pump(e.data.file, e.data.sab, e.data.startUs ?? 0);
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function pump(
  file: File,
  sab: SharedArrayBuffer,
  startUs: number,
): Promise<void> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
  const track: InputAudioTrack | null = await input.getPrimaryAudioTrack();
  if (!track) {
    self.postMessage({ type: "ERROR", message: "no audio track" });
    return;
  }
  const cfg = (await track.getDecoderConfig()) as AudioDecoderConfig | null;
  if (!cfg) {
    self.postMessage({ type: "ERROR", message: "no audio decoder config" });
    return;
  }

  const support = await AudioDecoder.isConfigSupported(cfg);
  if (!support.supported) {
    self.postMessage({
      type: "ERROR",
      message: `audio codec not supported: ${cfg.codec}`,
    });
    return;
  }

  const durationSec = await input.computeDuration();
  info = {
    codec: cfg.codec,
    sampleRate: cfg.sampleRate,
    numberOfChannels: cfg.numberOfChannels,
    durationSec,
  };
  self.postMessage({ type: "INFO", ...info });

  let totalFramesWritten = 0;

  const decoder = new AudioDecoder({
    output: (data: AudioData) => {
      const numFrames = data.numberOfFrames;
      const numCh = data.numberOfChannels;
      // Convert to interleaved stereo float32. AudioData is planar f32; copy each
      // channel separately then interleave.
      const planar: Float32Array[] = [];
      for (let ch = 0; ch < Math.min(numCh, 2); ch++) {
        const buf = new Float32Array(numFrames);
        data.copyTo(buf, { planeIndex: ch, format: "f32-planar" });
        planar.push(buf);
      }
      // Mono -> duplicate.
      if (planar.length === 1) planar.push(planar[0]);

      const interleaved = new Float32Array(numFrames * 2);
      for (let i = 0; i < numFrames; i++) {
        interleaved[i * 2] = planar[0][i];
        interleaved[i * 2 + 1] = planar[1][i];
      }
      ringWrite(sab, interleaved);
      totalFramesWritten += numFrames;
      data.close();
    },
    error: (err: DOMException) => {
      self.postMessage({ type: "ERROR", message: `audio decoder: ${err.message}` });
    },
  });

  decoder.configure(cfg);

  const sink = new EncodedPacketSink(track);
  // Seek to the key packet at-or-before startUs (in seconds)
  const startSec = startUs / 1_000_000;
  let pkt: EncodedPacket | null =
    startSec > 0
      ? await sink.getKeyPacket(startSec)
      : await sink.getFirstPacket();

  while (pkt && !stop) {
    while (decoder.decodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 1));
    }
    decoder.decode(pkt.toEncodedAudioChunk());
    pkt = await sink.getNextPacket(pkt);
  }
  await decoder.flush();
  decoder.close();
  self.postMessage({
    type: "DONE",
    totalFramesWritten,
    durationSec,
  });
}
