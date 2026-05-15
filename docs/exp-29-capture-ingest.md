# Exp-29 · Screen / Camera Capture Ingest

## Goal

Pipe `getDisplayMedia` (screen + system audio) and `getUserMedia`
(camera) through `MediaStreamTrackProcessor` → `VideoFrame` →
`VideoEncoder`, write encoded chunks to OPFS, and make the resulting
session **recoverable** if the tab crashes mid-recording. Demonstrate
the three subsystems the live-record surface needs (capture, live
encode, durable write) glued together.

## App Location

`apps/exp-29-capture-ingest/`

## Why This Matters in the Full NLE

Almost every browser-native editor ships some kind of "record"
surface: screen recorder, webcam recorder, video-message tool. The
naive route (`MediaRecorder` → blob) gives you a single file you
cannot edit until it finishes, with limited codec choices and no
crash recovery. The WebCodecs route gives per-frame control, better
codec selection, and the ability to flush a partial session to OPFS
chunk-by-chunk — exactly what a real editor needs for ingest.

## Key APIs

| API | Where used |
|---|---|
| `navigator.mediaDevices.getDisplayMedia({ video: { width: 3840 }, audio: true })` | Screen capture |
| `navigator.mediaDevices.getUserMedia({ video: true, audio: true })` | Camera capture |
| `navigator.mediaDevices.enumerateDevices()` | Front/back / device picker |
| `MediaStreamTrackProcessor` | Track → frame stream |
| `VideoEncoder` | Encode `VideoFrame` → `EncodedVideoChunk` |
| `FileSystemSyncAccessHandle` (worker) / async (main) | Write to OPFS |
| `navigator.storage.getDirectory()` | Locate recording dir |

## Pipeline

```
MediaStreamTrack(video) ─ MediaStreamTrackProcessor ─ ReadableStream<VideoFrame>
   │
   ├─ <video> preview
   └─ VideoEncoder ─ EncodedVideoChunk ─ OPFS write
                                          │
                                          └─ chunk index appended to session.json
```

Audio track is currently shown as a level meter only; production
would parallel-encode via `AudioEncoder` into a separate sidecar.
Encoded chunks are written as raw `avc1.640028` (H.264 High @ L4)
NAL bitstream to `/captures/{session}/video.h264` with a JSON
manifest tracking chunk offsets, timestamps, key-frame flags. **No
mp4-muxer dependency is added** — production would wrap with the
muxer covered in exp-10.

## Crash recovery

- On start, write `/captures/{session}/session.json` with `{ id,
  startedAt, status: "recording", codec, width, height }`.
- After each chunk, append to `chunks.json` (or fsync via sync access
  handle in a worker for speed).
- On stop, update `session.json` → `status: "complete"`.
- On page load, scan `/captures/`, list any sessions with `status:
  "recording"` as "recoverable"; offer to inspect / finalise.

## UI

- Two cards: **Screen** and **Camera**.
- Each: Start / Stop, preview `<video>`, device picker (camera only),
  codec selector (`avc1.640028`, `vp09.00.10.08`).
- Live stats: input fps, `videoEncoder.encodeQueueSize`, encoded
  bitrate (running average over 2 s), OPFS bytes written, dropped
  frames.
- Recoverable-sessions list: any partial sessions found on load,
  with "discard" / "inspect" buttons.

## Success Criteria

1. Five-minute screen recording at 1080p30 produces a single H.264
   bitstream in OPFS, with `chunks.json` listing every encoded chunk.
2. Killing the tab mid-record leaves a `status: "recording"` session
   visible on next load.
3. `encodeQueueSize` stays bounded (< 30) under sustained 4K30
   capture on a typical laptop.
4. Stop button properly closes the track, encoder (`flush()` +
   `close()`), and OPFS handle — no orphan sessions left in OPFS.

## Foot-guns

- `getDisplayMedia` width is a *hint* — UA may give you anything; check
  `track.getSettings()`.
- `MediaStreamTrackProcessor` is Chromium-only as of mid-2026. Fall
  back to `MediaRecorder` on other browsers.
- `VideoEncoder` requires `frame.close()` after `encoder.encode(frame)`
  — leaking frames hangs the pipeline immediately.
- OPFS `FileSystemFileHandle.createWritable()` overwrites by default;
  pass `{ keepExistingData: true }` to append, or use sync access
  handle for true append semantics.
- Some screen-share dialogs include a "stop sharing" UI surface that
  ends the track without your `stop()` call; listen for
  `track.onended`.
- Raw H.264 bitstreams (`.h264`) are not playable in most players;
  document this — they need muxing first (exp-10).
