# Test fixtures

Small, committed media so the experiments are reproducibly testable
without bringing your own files.

## What's here

| File | What | Use for |
|---|---|---|
| `tone-16k.wav` | 16 kHz mono, ~4 s, alternating tone / silence segments | Audio plumbing + perf: decode/resample (exp-26/32/33/39), silence detection (exp-32), denoise (exp-33), waveforms (exp-25), scopes audio paths |

Regenerate with:

```bash
node fixtures/generate.mjs
```

The generator is deterministic, so the committed `.wav` is reproducible.

## Why no `.mp4` is committed

The video experiments (WebCodecs decode, compositor, auto-reframe,
smart-cut motion) need a real **H.264** clip — WebCodecs decodes hardware
formats, not a hand-authored stub. This environment has no encoder
(`ffmpeg` absent) and a fabricated MP4 wouldn't decode, so shipping one
would be worse than none.

Make a tiny test clip locally instead:

```bash
# 2 s, 320x180, test pattern + 440 Hz tone, ~30–60 KB
ffmpeg -f lavfi -i testsrc=size=320x180:rate=15:duration=2 \
       -f lavfi -i sine=frequency=440:duration=2 \
       -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest fixtures/test.mp4
```

Or record one in the browser (any page, DevTools console):

```js
const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const r = new MediaRecorder(s, { mimeType: "video/mp4" });
const chunks = []; r.ondataavailable = e => chunks.push(e.data);
r.onstop = () => { const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
  a.download = "test.mp4"; a.click(); s.getTracks().forEach(t => t.stop()); };
r.start(); setTimeout(() => r.stop(), 2000);
```

`fixtures/test.mp4` is git-ignored so local clips don't get committed.

## What the tone can't test

`tone-16k.wav` has **no speech**, so it only exercises plumbing and
performance — not transcription quality (exp-26/32/39) or subject
detection (exp-34). Those need a real voice/video clip and a Chrome
WebGPU session to validate output.
