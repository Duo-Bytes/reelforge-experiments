/// <reference lib="webworker" />

import {
  createFile,
  MP4BoxBuffer,
  type ISOFile,
  type Sample,
  type Movie,
  type Track,
} from "mp4box";
import type {
  CodecConfig,
  DemuxResult,
  VideoSample,
} from "../lib/types";

type DemuxMsg = { type: "DEMUX"; file: File };
type GopMsg = {
  type: "GOP";
  reqId: string;
  targetUs: number;
};
type InMsg = DemuxMsg | GopMsg;

let cachedSamplesByPts: VideoSample[] | null = null;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    if (e.data.type === "DEMUX") {
      const result = await demux(e.data.file);
      cachedSamplesByPts = result.samplesByPts;
      self.postMessage({ type: "DEMUX_RESULT", result });
    } else if (e.data.type === "GOP") {
      // Inline binary search to keep timing self-contained inside the worker.
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
  const mp4: ISOFile<unknown, unknown> = createFile(false);

  let videoTrack: Track | null = null;
  let codecConfig: CodecConfig | null = null;
  const samples: VideoSample[] = [];

  const ready = new Promise<Movie>((resolve, reject) => {
    mp4.onError = (err: string) => reject(new Error(err));
    mp4.onReady = (info) => {
      const vt = info.videoTracks[0];
      if (!vt) {
        reject(new Error("no video track"));
        return;
      }
      videoTrack = vt;
      const description = extractCodecDescription(mp4, vt.id);
      const fps = vt.nb_samples / (vt.samples_duration / vt.timescale);
      codecConfig = {
        codec: vt.codec,
        description,
        width: vt.video?.width ?? 0,
        height: vt.video?.height ?? 0,
        fps,
      };
      mp4.setExtractionOptions(vt.id, null, { nbSamples: 1000 });
      mp4.start();
      resolve(info);
    };
    mp4.onSamples = (_id: number, _user: unknown, batch: Sample[]) => {
      for (const s of batch) {
        samples.push({
          ptsUs: (s.cts * 1_000_000) / s.timescale,
          dtsUs: (s.dts * 1_000_000) / s.timescale,
          durationUs: (s.duration * 1_000_000) / s.timescale,
          offset: s.offset,
          size: s.size,
          isKeyframe: s.is_sync,
        });
      }
    };
  });

  const CHUNK = 8 * 1024 * 1024;
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK, file.size);
    const slice = await file.slice(offset, end).arrayBuffer();
    const last = end >= file.size;
    const wrapped = MP4BoxBuffer.fromArrayBuffer(slice, offset);
    mp4.appendBuffer(wrapped, last);
    offset = end;
  }
  mp4.flush();

  await ready;

  if (!codecConfig || !videoTrack) throw new Error("demux incomplete");
  const vt: Track = videoTrack;

  const samplesByPts = samples.slice().sort((a, b) => a.ptsUs - b.ptsUs);
  const samplesByDts = samples.slice().sort((a, b) => a.dtsUs - b.dtsUs);

  const durationUs = (vt.samples_duration * 1_000_000) / vt.timescale;
  const parseMs = performance.now() - t0;

  return {
    source: "mp4box",
    config: codecConfig,
    samplesByPts,
    samplesByDts,
    durationUs,
    parseMs,
  };
}

function extractCodecDescription(
  mp4: ISOFile<unknown, unknown>,
  trackId: number,
): Uint8Array {
  const trak = mp4.getTrackById(trackId);
  if (!trak) throw new Error(`no trak for track ${trackId}`);
  // trak.mdia.minf.stbl.stsd.entries[0] holds avc1/hvc1 sample entry whose
  // children include avcC / hvcC. mp4box's TS types are loose here; we walk
  // the structure dynamically.
  const stbl = trak.mdia.minf.stbl;
  const entry = stbl.stsd.entries[0] as unknown as {
    avcC?: { write: (s: { buffer: ArrayBuffer; pos: number }) => void };
    hvcC?: { write: (s: { buffer: ArrayBuffer; pos: number }) => void };
  };

  const codecBox = entry.avcC ?? entry.hvcC;
  if (!codecBox) throw new Error("no avcC/hvcC sample entry — unsupported codec");

  // Use mp4box DataStream to serialize the box, then strip the 8-byte header.
  // Easier: search known children for `.data` field.
  const withData = codecBox as unknown as { data?: ArrayBufferLike };
  if (withData.data) {
    return new Uint8Array(withData.data);
  }

  // Fallback: serialize via box.write into a sized buffer.
  const buffer = new ArrayBuffer(8 * 1024);
  const stream = { buffer, pos: 0 };
  codecBox.write(stream);
  // stream.pos is total written; first 8 bytes are box size + type
  return new Uint8Array(buffer, 8, stream.pos - 8);
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
    byteEnd: last.offset + last.size,
    frameCount: end - start,
  };
}
