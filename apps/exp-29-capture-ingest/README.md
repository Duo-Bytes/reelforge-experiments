# exp-29 · Screen / Camera Capture Ingest

## Purpose

Pipe `getDisplayMedia` / `getUserMedia` through
`MediaStreamTrackProcessor` → `VideoEncoder` → OPFS. Provide
crash-recovery by tracking partial sessions in `session.json`.

## File map

```
src/app/page.tsx           Capture cards, live stats, recoverable list
src/lib/opfs-session.ts    Session dir / chunks.json / session.json
src/lib/encoder-pipeline.ts  Track → VideoFrame → VideoEncoder → OPFS
src/lib/stats.ts           Rolling fps / bitrate / queue-depth counters
```

## What this shows

- **Screen card**: `getDisplayMedia({ video: { width: 3840 }, audio:
  true })`, preview `<video>`, encoder pipeline.
- **Camera card**: `getUserMedia({ video: true, audio: true })`, device
  picker (front/back via `enumerateDevices`), same encoder pipeline.
- Codec selector: `avc1.640028` (H.264 High 4) or `vp09.00.10.08`.
- Live stats: input fps, `encodeQueueSize`, encoded bitrate (rolling
  2 s average), OPFS bytes written, dropped frames.
- Crash recovery: on each session start, `session.json` is written
  with `status: "recording"`. Each chunk appends to `chunks.json`. On
  page load, any session still flagged "recording" is listed as
  recoverable.

## Output format

```
/captures/{session}/
  session.json   { id, startedAt, status, codec, width, height }
  chunks.json    [{ ts, dur, kf, byteOffset, byteLength }, ...]
  video.h264     raw AnnexB-style bitstream (NOT mp4)
```

**Production note**: raw H.264 isn't playable in most consumer
players. Production would wrap the bitstream with the muxer covered
in exp-10. We deliberately do not add an mp4-muxer dependency here;
this experiment isolates the capture-write path.

## Running

```
pnpm --filter exp-29-capture-ingest dev
```

Grant the screen-share or camera permission when prompted.

## Success criteria

1. 5 min screen recording at 1080p30 produces a single H.264 stream
   in OPFS plus a complete `chunks.json`.
2. Closing the tab mid-record leaves a `status: "recording"` session
   on next load.
3. `encodeQueueSize` stays bounded (< 30) under sustained 4K30.
4. Stop closes track / encoder / file handles cleanly.

## Foot-guns

- `MediaStreamTrackProcessor` is Chromium-only as of mid-2026.
- `VideoFrame` must be `.close()`d after `.encode()` or the pipeline
  hangs immediately.
- "Stop sharing" UI ends the track without your `stop()` call; listen
  for `track.onended`.
- `getDisplayMedia` width is a hint; check `track.getSettings()`.
