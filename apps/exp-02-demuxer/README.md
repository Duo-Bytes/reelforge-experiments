# exp-02 · MP4 Demuxer

## Purpose

Parse an MP4 file, extract codec config (codec string + `avcC`/`hvcC` description), and build a per-sample seek index `{ ptsUs, dtsUs, durationUs, offset, size, isKeyframe }`. WebCodecs `VideoDecoder` does not parse containers — without this index, exp-03 cannot run. Also evaluate **mp4box.js vs mediabunny** to pick the demuxer for the rest of the project.

## Architecture

```
Main Thread (page.tsx)
├── File input -> postMessage({type:"DEMUX", file}) to BOTH workers in parallel
├── Receives DEMUX_RESULT from each, displays metrics + samples summary
├── On every result: VideoDecoder.isConfigSupported(...) -> YES/NO badge
└── GOP query input (ms) -> both workers do binary search + return {gop, queryMs}

mp4box.worker.ts
├── createFile(false) -> ISOFile
├── mp4.onReady -> codec, dimensions, fps, extract avcC/hvcC bytes
├── chunk loop: file.slice(off, off+8MB) -> MP4BoxBuffer.fromArrayBuffer(buf, off) -> appendBuffer
├── mp4.onSamples -> push {ptsUs=cts*1e6/timescale, dtsUs, durationUs, offset, size, is_sync}
├── samplesByPts (sorted) + samplesByDts (sorted) cached
└── GOP -> binary search PTS, walk back to keyframe, walk fwd to next keyframe, time the call

mediabunny.worker.ts
├── new Input({formats: ALL_FORMATS, source: new BlobSource(file)})
├── input.getPrimaryVideoTrack() -> InputVideoTrack
├── track.getDecoderConfig() -> ready VideoDecoderConfig (codec + description)
├── EncodedPacketSink(track) -> getFirstPacket / getNextPacket loop
└── packet -> {ptsUs=ts*1e6, dtsUs=ptsUs, durationUs, offset:-1, size:data.byteLength, isKeyframe}
```

## Research notes

- **mp4box v2 ships TypeScript types and `MP4BoxBuffer.fromArrayBuffer(buffer, fileStart)`** — replaces the old "mutate `.fileStart` on the ArrayBuffer" trick. Cleaner, no ambient typing.
- **`avcC` / `hvcC` extraction.** mp4box exposes the box's `.data` field which is the raw box body without the 8-byte size+type header — exactly what `VideoDecoder.configure({description})` wants. If `.data` is unavailable, `box.write(stream)` serializes and we strip the first 8 bytes.
- **Mediabunny does NOT expose source-file byte offsets per packet.** It returns `EncodedPacket.data: Uint8Array` (the actual bytes). For exp-03 (decode) this is ergonomic — feed `data` straight into `VideoDecoder`. For pipelines that *require* offsets (proxy export reading from OPFS) we still need mp4box. Verdict: **use mediabunny for the decode path, mp4box where raw byte ranges are needed.**
- **Mediabunny stats live on `PacketStats`, not `InputVideoTrack`.** Use `await track.computePacketStats(1000)` then read `.averagePacketRate` (this equals fps).
- **`fileStart` correctness is non-negotiable.** Feed chunks in order with the right offsets or mp4box silently fails to parse.
- **`moov` at end of file.** Non-web-optimized files require the whole stream before parsing succeeds; we feed the entire file in one pass anyway, so this works either way. Production fix is to re-mux on ingest.

## Files

| File | Purpose |
|---|---|
| `src/lib/types.ts` | `VideoSample`, `CodecConfig`, `DemuxResult`, `GopRange`, `getSamplesForGOP` binary search |
| `src/workers/mp4box.worker.ts` | mp4box.js demuxer + GOP query |
| `src/workers/mediabunny.worker.ts` | mediabunny demuxer + findings comment block |
| `src/app/page.tsx` | Dual-worker comparison UI + GOP query timing |

## Run

```bash
pnpm --filter exp-02-demuxer dev
```

## Success criteria

| Metric | Target |
|---|---|
| 1GB MP4 parse | < 5s |
| GOP query | < 1ms |
| `VideoDecoder.isConfigSupported` | `{supported: true}` |
| Both demuxers documented | mp4box + mediabunny side-by-side |
