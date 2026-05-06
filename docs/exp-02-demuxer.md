# Exp-02 · MP4 Demuxer

## Goal

Parse an MP4 file stored in OPFS, extract track metadata (codec string, resolution, framerate, duration), and build a seek index that maps any timestamp to: the byte offset of its I-frame (keyframe) and all subsequent delta frames in that GOP.

Evaluate both `mp4box.js` and `mediabunny` for this purpose and decide which to carry forward.

---

## App Location

`apps/exp-02-demuxer/`

## Why This Matters in the Full NLE

WebCodecs `VideoDecoder` does not parse containers. It requires raw `EncodedVideoChunk` objects. To get those, we must:
1. Know which bytes in the OPFS file correspond to each video sample
2. Know the codec, dimensions, and codec-specific initialization data (the `avcC`/`hvcC` box)
3. For any target timestamp, locate the nearest preceding I-frame and all subsequent frames up to the next I-frame (the GOP)

Without a correct seek index, frame-accurate seeking is impossible.

---

## Key APIs & Libraries

| Tool | npm Package | Notes |
|---|---|---|
| mp4box.js | `mp4box` | GPAC's JS port; streaming `appendBuffer()` API; well-tested |
| mediabunny | `mediabunny` | Newer; zero-dependency TS; check if it handles non-fragmented MP4 |
| OPFS reads | From exp-01 worker | `READ_RANGE` messages |

---

## MP4 Structure You Need to Understand

An MP4 file has two critical top-level boxes:
- **`moov`** (movie metadata): contains all track info, sample tables, codec init data
- **`mdat`** (media data): raw compressed video/audio bytes

A "web-optimized" MP4 has `moov` at the start (before `mdat`). Non-optimized files have `moov` at the end. You must handle both cases. If `moov` is at the end, the demuxer needs to read the end of the file first.

Inside `moov` → `trak` → `mdia` → `minf` → `stbl` (sample table box), you need:
- **`stts`** — maps sample → duration (needed for timestamp)
- **`stss`** — list of keyframe sample numbers (I-frames)
- **`stsc`** — sample-to-chunk mapping
- **`stco`/`co64`** — chunk byte offsets
- **`stsz`** — sample sizes in bytes
- **`avcC`** or **`hvcC`** — codec initialization data (inside `stsd` box)

The result of parsing is a flat array:
```ts
type VideoSample = {
  timestamp: number   // microseconds (WebCodecs uses microseconds)
  duration: number    // microseconds
  offset: number      // byte offset in OPFS file
  size: number        // byte length
  isKeyframe: boolean
}
```

---

## Architecture

```
OPFSWorker (from exp-01, extended)
│
└── DemuxWorker (new)
    ├── Receives OPFS file chunks via postMessage
    ├── Feeds chunks to mp4box.js appendBuffer()
    ├── On moov parsed: extract VideoSample[] index
    ├── Stores index in memory (or IndexedDB if > 100MB)
    └── Exposes: getSamplesForGOP(targetTs: number) → VideoSample[]
```

The demux worker requests OPFS chunks from the OPFS worker. It does NOT read OPFS directly — only the OPFS worker owns the `SyncAccessHandle`.

---

## Implementation Steps

### 1. Install dependencies

```bash
npm install mp4box mediabunny
npm install -D @types/mp4box  # if available, otherwise declare module
```

### 2. Parse with mp4box.js

```ts
import MP4Box from 'mp4box'

const mp4 = MP4Box.createFile()
let videoSamples: VideoSample[] = []
let codecConfig: { codec: string; description: Uint8Array; width: number; height: number }

mp4.onReady = (info) => {
  const videoTrack = info.tracks.find(t => t.type === 'video')
  if (!videoTrack) throw new Error('No video track')

  // codec string for VideoDecoder.isConfigSupported()
  const codec = videoTrack.codec  // e.g. "avc1.640028"

  // Extract avcC/hvcC box bytes
  const trak = mp4.getTrackById(videoTrack.id)
  const description = getCodecDescription(trak)

  codecConfig = { codec, description, width: videoTrack.video.width, height: videoTrack.video.height }
  mp4.setExtractionOptions(videoTrack.id, null, { nbSamples: Infinity })
  mp4.start()
}

mp4.onSamples = (id, user, samples) => {
  for (const s of samples) {
    videoSamples.push({
      timestamp: (s.cts * 1_000_000) / s.timescale,  // convert to microseconds
      duration: (s.duration * 1_000_000) / s.timescale,
      offset: s.offset,
      size: s.size,
      isKeyframe: s.is_sync,
    })
  }
}

// Feed OPFS chunks to mp4box
// mp4box REQUIRES a 'fileStart' property on each ArrayBuffer
let fileOffset = 0
function feedChunk(bytes: ArrayBuffer) {
  const buf = bytes as ArrayBuffer & { fileStart: number }
  buf.fileStart = fileOffset
  fileOffset += bytes.byteLength
  mp4.appendBuffer(buf)
  mp4.flush()
}
```

**Critical:** The `fileStart` property must be set correctly. If chunks are fed out of order or with wrong offsets, mp4box silently fails to parse.

### 3. Extract codec description bytes

```ts
function getCodecDescription(trak: any): Uint8Array {
  // Navigate: trak → mdia → minf → stbl → stsd → avc1/hvc1 → avcC/hvcC
  const stsd = trak.mdia.minf.stbl.stsd
  const entry = stsd.entries[0]

  // H.264
  if (entry.avcC) {
    return new Uint8Array(entry.avcC.data)  // raw avcC box contents
  }
  // H.265
  if (entry.hvcC) {
    return new Uint8Array(entry.hvcC.data)
  }
  throw new Error('Unsupported codec — no avcC or hvcC found')
}
```

The `description` bytes are the raw box body, NOT including the 4-byte size + 4-byte type header. mp4box's `.data` field gives you exactly this.

### 4. Build the GOP seek function

```ts
function getSamplesForGOP(targetUs: number): VideoSample[] {
  // Sort by timestamp (should already be sorted, but be safe)
  const sorted = videoSamples  // assume pre-sorted

  // Find the sample index for the target timestamp
  let targetIdx = 0
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].timestamp <= targetUs) targetIdx = i
    else break
  }

  // Walk backward to find the nearest keyframe
  let gopStart = targetIdx
  while (gopStart > 0 && !sorted[gopStart].isKeyframe) {
    gopStart--
  }

  // Walk forward to find the end of this GOP (next keyframe or end of file)
  let gopEnd = gopStart + 1
  while (gopEnd < sorted.length && !sorted[gopEnd].isKeyframe) {
    gopEnd++
  }

  return sorted.slice(gopStart, gopEnd)
}
```

### 5. Test mediabunny as alternative

Mediabunny has a different API. Read its docs and build the same `getSamplesForGOP` using it. Key things to check:
- Does it handle non-fragmented MP4 (progressive download style)?
- Does it expose sample byte offsets (not just timestamps)?
- Does it expose the `avcC`/`hvcC` bytes?
- API ergonomics vs mp4box.js?

Document findings in a comment block at the top of the mediabunny implementation file.

### 6. Build the UI

Show:
- File picker → triggers OPFS ingest (exp-01 logic) then demux
- Display: codec, resolution, fps, duration, total frame count, I-frame count
- Input: "Seek to timestamp (ms)" → display the GOP range (first sample offset, last sample offset, frame count in GOP)
- Timer: time from timestamp input to GOP identified (target: <1ms)

---

## Known Pitfalls

**`moov` at end of file (non-web-optimized MP4).**
mp4box will wait until it receives the `moov` box. If `moov` is at the end, you must feed the whole file first. Detect this by checking if `mp4.onReady` hasn't fired after feeding 10MB. If so, feed the rest of the file, then retry. Production fix: re-mux files to have `moov` first (use FFmpeg.wasm once on ingest, or use the proxy worker in exp-07 which re-encodes anyway).

**Timescale conversion.**
MP4 timestamps are in units of `sample.timescale` (often 90000 for video). WebCodecs timestamps are in microseconds. Always convert: `microseconds = (cts * 1_000_000) / timescale`. Getting this wrong causes A/V desync and seek failures.

**`mp4box.onSamples` may fire multiple times.**
It fires in batches. Append to the array, don't replace it.

**B-frames: DTS vs PTS.**
Some H.264 files have B-frames (bi-directional prediction). For these, `cts` (composition time = PTS) differs from `dts` (decode time). The seek index must be sorted by PTS for display, but samples must be fed to VideoDecoder in DTS order. mp4box exposes both — store both.

**mediabunny unknown maturity.**
If mediabunny doesn't expose raw byte offsets for individual samples, it cannot be used as the primary demuxer (WebCodecs needs the actual bytes). Verify this in your mediabunny investigation before committing.

---

## Success Criteria

| Metric | Target |
|---|---|
| Parse 1GB MP4, build full seek index | < 5 seconds |
| `getSamplesForGOP(targetUs)` call | < 1ms |
| Codec string matches `VideoDecoder.isConfigSupported()` | Must return `{ supported: true }` |
| GOP byte range for a known I-frame | Exactly matches raw bytes in file (verify with hex editor) |
| Both mp4box.js and mediabunny implementations documented | ✓ |

---

## Feeds Into

- **Exp-03** receives `VideoSample[]` from `getSamplesForGOP()` and feeds them into `VideoDecoder`
- **Exp-07** uses codec config from this experiment to configure the proxy encoder
- **Exp-08** uses the same demuxer for audio track extraction
