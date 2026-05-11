/// <reference lib="webworker" />

/*
 * Mediabunny demuxer findings (2026-05)
 * --------------------------------------
 * + High-level API: `Input` + `EncodedPacketSink`. Reads packets in decode
 *   order via `getFirstPacket` / `getNextPacket` / `getKeyPacket(timestamp)`.
 * + Returns `EncodedPacket { data: Uint8Array, type, timestamp(s), duration(s) }`.
 * + Provides `getDecoderConfig()` returning a ready-made `VideoDecoderConfig`
 *   (codec string + description bytes) — strictly more ergonomic than the
 *   manual avcC-walk required for mp4box.
 * + Handles `moov`-at-end transparently via Source range reads.
 *
 * - **`EncodedPacket` does NOT expose the source-file byte offset of the
 *   underlying sample.** Bytes are returned directly via `packet.data`, so for
 *   exp-03 (WebCodecs decode) this is fine — feed `packet.data` straight to
 *   `VideoDecoder.decode(...)`.
 * - For pipelines that *require* byte offsets (e.g. proxy export reading
 *   straight from OPFS), you must either re-read via the offset+size from
 *   mp4box, or accept that mediabunny will re-read bytes internally each time
 *   from its `Source`.
 *
 * Verdict: mediabunny is the better DX for the decode path (decoder config +
 * packet bytes). mp4box is still required where raw byte ranges are needed
 * for downstream subsystems that bypass mediabunny.
 */

import {
  Input,
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  type InputVideoTrack,
  type EncodedPacket,
} from "mediabunny";
import type { CodecConfig, DemuxResult, VideoSample } from "../lib/types";

type DemuxMsg = { type: "DEMUX"; file: File };
type GopMsg = { type: "GOP"; reqId: string; targetUs: number };
type InMsg = DemuxMsg | GopMsg;

let cachedSamplesByPts: VideoSample[] | null = null;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "DEMUX") {
      const result = await demux(e.data.file);
      cachedSamplesByPts = result.samplesByPts;
      self.postMessage({ type: "DEMUX_RESULT", result });
    } else if (e.data.type === "GOP") {
      if (!cachedSamplesByPts) throw new Error("no demux result cached");
      const t0 = performance.now();
      const gop = locateGop(cachedSamplesByPts, e.data.targetUs);
      const queryMs = performance.now() - t0;
      self.postMessage({
        type: "GOP_RESULT",
        reqId: e.data.reqId,
        gop,
        queryMs,
      });
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function demux(file: File): Promise<DemuxResult> {
  const t0 = performance.now();

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });

  const track: InputVideoTrack | null = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track");

  const decoderConfig = await track.getDecoderConfig();
  if (!decoderConfig) throw new Error("no decoder config from mediabunny");

  const description = decoderConfig.description
    ? new Uint8Array(
        decoderConfig.description instanceof ArrayBuffer
          ? decoderConfig.description
          : (decoderConfig.description as ArrayBufferView).buffer,
      )
    : new Uint8Array(0);

  const codedWidth = await track.getCodedWidth();
  const codedHeight = await track.getCodedHeight();
  const stats = await track.computePacketStats(1000);

  const config: CodecConfig = {
    codec: decoderConfig.codec,
    description,
    width: codedWidth,
    height: codedHeight,
    fps: stats.averagePacketRate,
  };

  const sink = new EncodedPacketSink(track);
  const samples: VideoSample[] = [];
  let packet: EncodedPacket | null = await sink.getFirstPacket();
  while (packet) {
    samples.push(packetToSample(packet));
    packet = await sink.getNextPacket(packet);
  }

  // Mediabunny iterates in decode order, so dts ordering is implicit.
  const samplesByDts = samples.slice();
  const samplesByPts = samples.slice().sort((a, b) => a.ptsUs - b.ptsUs);

  const durationSec = await input.computeDuration();
  const durationUs = Math.round(durationSec * 1_000_000);

  const parseMs = performance.now() - t0;

  return {
    source: "mediabunny",
    config,
    samplesByPts,
    samplesByDts,
    durationUs,
    parseMs,
  };
}

function packetToSample(p: EncodedPacket): VideoSample {
  const ptsUs = Math.round(p.timestamp * 1_000_000);
  const durationUs = Math.round(p.duration * 1_000_000);
  return {
    ptsUs,
    // Mediabunny doesn't expose dts directly; for non-B-frame streams dts == pts.
    // Sequence number ordering is preserved by iteration order.
    dtsUs: ptsUs,
    durationUs,
    // No source-file offset available — placeholder so downstream code that
    // doesn't need offsets still works. Use mp4box for offset-dependent paths.
    offset: -1,
    size: p.data.byteLength,
    isKeyframe: p.type === "key",
  };
}

function locateGop(
  samples: VideoSample[],
  targetUs: number,
): {
  startIdx: number;
  endIdx: number;
  byteStart: number;
  byteEnd: number;
  frameCount: number;
} | null {
  if (samples.length === 0) return null;
  let lo = 0;
  let hi = samples.length - 1;
  let targetIdx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].ptsUs <= targetUs) {
      targetIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  let start = targetIdx;
  while (start > 0 && !samples[start].isKeyframe) start--;
  let end = start + 1;
  while (end < samples.length && !samples[end].isKeyframe) end++;
  const first = samples[start];
  const last = samples[end - 1];
  return {
    startIdx: start,
    endIdx: end,
    byteStart: first.offset,
    byteEnd: first.offset >= 0 ? last.offset + last.size : -1,
    frameCount: end - start,
  };
}
