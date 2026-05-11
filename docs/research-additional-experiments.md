# Additional Experiments — Research Report (May 2026)

Audience: engineer planning the next batch of de-risking spikes for the
client-side, privacy-first, Chrome-120+ NLE. The existing 12 experiments cover
the I/O, decode, GPU, audio-sync, state, export, and one ML spike. This report
identifies the experiments still missing before integration, justified against
public engineering write-ups and current Chrome platform status.

---

## 1. TL;DR — Top 5 highest-risk gaps

Ranked by the probability that shipping without a dedicated experiment will
cause a v1 disaster.

1. **Color management end-to-end** — none of the 12 experiments explicitly
   declare a working color space. WebGPU canvas defaults to sRGB; user MP4s are
   BT.709 limited-range YCbCr; an HDR10/HLG iPhone clip will land in the
   compositor as garbage and the export will be off. Worth its own spike before
   exp-04 grows tendrils everywhere.
2. **WebCodecs backpressure & VideoFrame lifetime** — every WebCodecs blog post
   eventually talks about the "traffic jam" in front of the decoder and the
   VRAM leak from un-`close()`d frames. This is cross-cutting (decode, cache,
   compositor, export) and needs a controlled benchmark, not ad-hoc per-app
   fixes.
3. **GPU device-lost recovery** — Chrome routinely loses the WebGPU device on
   driver updates, sleep/wake, and tab-throttle. Without a tested recovery
   path the editor will silently corrupt unsaved work for any session > a few
   hours.
4. **Project file format + autosave/crash recovery** — exp-09 covers in-memory
   timeline state but says nothing about how it persists, how versions migrate,
   or how a crashed tab is recovered. Every shipped browser editor has lost
   user projects to this; Clipchamp is being abandoned right now over similar
   data-loss bugs.
5. **Codec coverage matrix + hardware-accel detection** — `isConfigSupported()`
   with `hardwareAcceleration: "prefer-hardware"` is the only honest way to
   know what a user's machine can do. HEVC/AV1/VP9/ProRes coverage is a per-OS
   minefield and the proxy workflow (exp-07) silently depends on it.

---

## 2. Proposed experiments (13 onward)

Format matches existing exp-XX docs: **Name | Proves | Key APIs | Depends On |
Complexity** with one citation per row.

### 13. Color Management & HDR Pipeline
- **Proves:** A BT.709 SDR clip, a Display-P3 image, and an HDR10/PQ HEVC clip
  all composite correctly into a single timeline and export to a chosen target
  color space (sRGB SDR, P3 SDR, or HDR10) with correct tone-mapping at the
  edges. Drives WGSL transfer-function code and verifies `GPUCanvasContext`
  configuration.
- **Key APIs:** `GPUCanvasContext.configure({ colorSpace, toneMapping })`,
  `VideoFrame.colorSpace`, `VideoDecoderConfig.colorSpace`, WGSL with explicit
  PQ/HLG/sRGB EOTF/OETF, `<canvas>` `colorSpace: "display-p3"`.
- **Depends on:** exp-03, exp-04.
- **Complexity:** High.
- **Why dedicated:** "WebGPU defaults to sRGB; ultra-wide gamut (Rec.2020) and
  HDR support is deferred to a subsequent proposal" and Chrome only tone-maps
  HDR10 static metadata, dropping HDR10+ dynamic metadata silently.[^webgpu-hdr][^chrome-hdr]

### 14. WebCodecs Backpressure & VideoFrame Lifetime Bench
- **Proves:** A pipeline can sustain decode → GPU upload → render → close at
  4K60 without growing VRAM, with explicit `decodeQueueSize` watermarks and
  `ReadableStream` backpressure. Includes a deliberate-leak harness.
- **Key APIs:** `VideoDecoder.decodeQueueSize`, `VideoFrame.close()`,
  `WritableStream`/`ReadableStream` with `highWaterMark`, `performance.measureUserAgentSpecificMemory()`.
- **Depends on:** exp-03, exp-06.
- **Complexity:** Medium.
- **Why dedicated:** "VideoFrame objects … hold actual GPU memory. If you don't
  manually close them, your application becomes a memory leak nightmare." A
  "traffic jam" forms in front of the decoder if upstream is faster than
  downstream.[^remotion-webcodecs][^webcodecs-leak]

### 15. GPU Device-Lost Recovery
- **Proves:** When `device.lost` fires (forced via DevTools, driver update,
  background-tab eviction), the editor recreates adapter/device, re-uploads
  pipelines/buffers/textures, and resumes playback within < 1 s. Survives a
  scripted loop of forced losses.
- **Key APIs:** `GPUDevice.lost` Promise, `GPUDeviceLostInfo.reason`, adapter
  re-request, resource registry.
- **Depends on:** exp-04, exp-05.
- **Complexity:** High.
- **Why dedicated:** "Many causes for lost devices are transient, so you should
  try getting a new device once a previous one has been lost" — but every
  resource has to be tracked and re-created; no engine (Three.js, PlayCanvas,
  Bevy) has fully solved this.[^toji-device-lost][^bevy-loss]

### 16. Project File Format, Autosave & Crash Recovery
- **Proves:** Timeline + asset references serialize to a versioned format on
  OPFS with a write-ahead journal; killing the tab mid-edit recovers to the
  last consistent state on next open; format migrations between schema
  versions round-trip.
- **Key APIs:** OPFS sync access handles for atomic journal writes,
  `BeforeUnload`, `visibilitychange`, structured-clone for deep snapshots,
  `Storage.persist()`.
- **Depends on:** exp-01, exp-09.
- **Complexity:** Medium.
- **Why dedicated:** Even mature desktop NLEs (Shotcut, Revit, MS Project) ship
  with documented "manually recover the autosave/journal" recipes — proof that
  doing this casually does not work.[^shotcut-recover]

### 17. Codec Coverage & Hardware-Accel Probe
- **Proves:** A startup probe that calls `isConfigSupported()` for the full
  matrix (H.264/HEVC/VP9/AV1, 8/10-bit, alpha, with both
  `prefer-hardware`/`prefer-software`) and produces a capability profile that
  the rest of the app branches on (proxy required? software fallback? feature
  hidden?). Includes anonymized telemetry shape.
- **Key APIs:** `VideoDecoder.isConfigSupported`, `VideoEncoder.isConfigSupported`,
  `navigator.userAgentData`, `navigator.gpu.requestAdapter().info`.
- **Depends on:** exp-03, exp-07.
- **Complexity:** Low.
- **Why dedicated:** "A common strategy will be to prioritize hardware
  acceleration at higher resolutions with a fallback to software codecs if
  hardware acceleration fails" — but Chrome HEVC support requires a build
  flag/OS decoder and silently varies by platform.[^isconfig][^hevc-stazhu]

### 18. Storage Quota & Eviction Drill
- **Proves:** OPFS write loop hitting `QuotaExceededError` recovers gracefully
  (LRU eviction of proxies and frame cache); `navigator.storage.persist()` is
  requested at the right moment; `estimate()` drives a UI; user is warned
  before the browser silently evicts the whole origin.
- **Key APIs:** `navigator.storage.estimate()`, `navigator.storage.persist()`,
  `QuotaExceededError`, `StorageManager`.
- **Depends on:** exp-01.
- **Complexity:** Low.
- **Why dedicated:** "When an origin's data is evicted by the browser, all of
  its data, not parts of it, is deleted at the same time" — non-persistent
  origins can lose every project at once. Chrome lets a single origin use up
  to 60% of disk.[^mdn-quota]

### 19. Multi-Tab Coordination via Web Locks
- **Proves:** Two tabs opening the same project negotiate a single writer; the
  reader tab observes changes; primary fail-over works on tab close/crash;
  OPFS sync handles never overlap.
- **Key APIs:** `navigator.locks.request()`, `BroadcastChannel`, `FileSystemObserver`
  on OPFS, `pagehide`.
- **Depends on:** exp-01, exp-16.
- **Complexity:** Medium.
- **Why dedicated:** Two tabs with sync access handles to the same OPFS file =
  immediate corruption. Web Locks is the documented primary-tab pattern.[^web-locks]

### 20. Color Grading: 3D LUT Sampling + Primaries
- **Proves:** Loads industry-standard `.cube` 17/33/65-pt LUTs into a 3D
  texture, samples in WGSL with proper trilinear filtering, applies before/
  after gamma; matches DaVinci output within ΔE76 tolerance on a reference
  ramp.
- **Key APIs:** `GPUTexture` with `dimension: "3d"`, `texture_3d<f32>`, WGSL
  `textureSampleLevel`, file parser for `.cube`.
- **Depends on:** exp-04, exp-13.
- **Complexity:** Medium.
- **Why dedicated:** ".cube is the industry standard … every major NLE —
  Resolve, Premiere, FCP — supports it natively." Without this the editor
  cannot ingest a standard creator workflow asset.[^lut-cube]

### 21. Subtitle/Caption Rendering (ASS + WebVTT)
- **Proves:** Burn-in and live overlay of `.ass` (with styles, karaoke,
  positioning) and `.vtt` cues; rendered on an `OffscreenCanvas` in a worker
  and composited as a texture; respects timeline scrubbing and export.
- **Key APIs:** `OffscreenCanvas` 2D, libass-WASM (SubtitlesOctopus), VTT
  parser, `texImage2D`-equivalent upload.
- **Depends on:** exp-04, exp-05.
- **Complexity:** Medium.
- **Why dedicated:** ASS/SSA is the dominant fan-edit format and "styling will
  be removed when converting from ASS" — burn-in needs the libass renderer,
  not WebVTT.[^subtitles-octopus]

### 22. GPU Text Rendering (MSDF) for Titles & Lower-Thirds
- **Proves:** Text layers with arbitrary fonts, kerning, Latin + CJK + emoji
  fall-back, animated transforms at 60 fps. MSDF atlas generation on first
  use of a font; SDF sampling in WGSL.
- **Key APIs:** `FontFace.load()`, OffscreenCanvas for atlas bake,
  `texture_2d_array<f32>` for atlases, WGSL screen-space derivatives.
- **Depends on:** exp-04.
- **Complexity:** High (RTL + complex shaping is "hardcore mode").
- **Why dedicated:** "Use.GPU does not support complex Unicode scripts or RTL
  text yet — both are a can of worms"; no off-the-shelf WebGPU title
  renderer exists.[^use-gpu-text]

### 23. Effects/Transitions Framework with Bezier Keyframes
- **Proves:** A plugin contract for effects with typed parameter schemas; a
  bezier-curve animation system (handle-based, broken-tangent option) that
  evaluates at any time; deterministic ordering of stacked effects.
- **Key APIs:** WGSL preprocessor for parameter injection, structured-clone
  for plugin params, custom evaluator (no built-in API).
- **Depends on:** exp-04, exp-09.
- **Complexity:** High.
- **Why dedicated:** Bezier keyframes with locked/broken tangents and a graph
  editor are how every NLE animates parameters; no spec, has to be built and
  proven to perform at scale.[^bezier-keyframes]

### 24. Audio Mixing Graph (Gain/Pan/EQ/Compression/Ducking)
- **Proves:** Multi-track mix bus with per-clip gain/pan automation, a 4-band
  EQ and a compressor implemented in a WASM AudioWorklet, sidechain ducking
  between two tracks, all running glitch-free under a 60-fps render load.
- **Key APIs:** `AudioWorkletNode`, `AudioParam` automation, `SharedArrayBuffer`
  for control, Wasm-Audio-Worklets, `AudioContext.outputLatency`.
- **Depends on:** exp-08.
- **Complexity:** High.
- **Why dedicated:** "By running a WASM module within an Audio Worklet,
  developers can execute high-performance DSP code in a stable, low-latency,
  real-time environment" — but exp-08 only covers sync, not mixing.[^audio-worklet-wasm]

### 25. Waveform Generation & Filmstrip Thumbnails
- **Proves:** Multi-resolution peak files (256/4096/65536-sample bins)
  generated in a worker on ingest, persisted in OPFS, drawn at any zoom
  without re-decoding; filmstrip thumbnails generated by seeking to GOP
  boundaries and downscaling on GPU.
- **Key APIs:** `AudioContext.decodeAudioData` or WASM decoder, `Worker`,
  WebCodecs decode at low resolution, OPFS for cache.
- **Depends on:** exp-01, exp-03.
- **Complexity:** Medium.
- **Why dedicated:** BBC's `waveform-data.js` proves the worker pattern is
  required ("by default this step is done using a Web Worker") and timeline
  filmstrips are table-stakes UX; no built-in API.[^waveform-data]

### 26. Speech-to-Text / Auto-Captions On-Device
- **Proves:** A 1-hour audio file produces an aligned word-level transcript
  in < real-time on a mid-tier laptop, using either Whisper-tiny via
  onnxruntime-web/WebGPU or Moonshine; output renders into the captions
  pipeline (exp-21).
- **Key APIs:** `onnxruntime-web` WebGPU EP, WebNN where available, AudioWorklet
  for VAD, `OfflineAudioContext` for resampling.
- **Depends on:** exp-08, exp-11, exp-21.
- **Complexity:** High.
- **Why dedicated:** "Moonshine achieves 107 ms latency vs 11,286 ms for Whisper
  Large V3 on the same hardware"; model selection and quantization is a real
  decision that warrants benchmarking before integration.[^moonshine]

### 27. Compute-Pressure Adaptive Quality
- **Proves:** A `PressureObserver` driving the compositor to drop preview
  resolution / disable expensive effects / pause background proxy transcoding
  when the system enters `serious`/`critical`. Survives a 30-min stress test
  without thermal-throttling jank.
- **Key APIs:** `PressureObserver` (CPU and GPU sources), Long Animation
  Frames API for cross-checking.
- **Depends on:** exp-04, exp-07.
- **Complexity:** Low.
- **Why dedicated:** Compute Pressure shipped from Chrome 125 specifically to
  let "video conferencing web apps" reduce quality before drops happen — same
  logic applies to NLE preview.[^compute-pressure]

### 28. Long Animation Frames Performance Budget
- **Proves:** A continuous LoAF observer in the integration shell that
  attributes blocking work to specific scripts/handlers, fails CI when median
  LoAF > 50 ms during a scripted scrub-and-edit session.
- **Key APIs:** `PerformanceObserver({ type: "long-animation-frame" })`,
  `PerformanceLongAnimationFrameTiming.scripts`, `performance.measureUserAgentSpecificMemory`.
- **Depends on:** exp-09, exp-12.
- **Complexity:** Low.
- **Why dedicated:** "A long task does not include the part where the browser
  updates what you see on the screen … even if these updates take a long time
  and make a website feel sluggish, they're not counted as a long task" —
  Long Tasks is not enough for a 60 fps timeline.[^loaf]

### 29. Screen / Camera Capture Ingest
- **Proves:** `getDisplayMedia` at 4K30 with system audio piped through
  `MediaStreamTrackProcessor` → `VideoFrame` → encoder → OPFS, recoverable on
  crash; same path for `getUserMedia` from camera.
- **Key APIs:** `getDisplayMedia({ video: { width: 3840 }, audio: true })`,
  `MediaStreamTrackProcessor`, `VideoEncoder`, `MediaRecorder` as fallback.
- **Depends on:** exp-03, exp-10.
- **Complexity:** Medium.
- **Why dedicated:** Most browser editors have a "record" surface; this glues
  three subsystems exp-XX never touch (capture, live encode, durable write).[^getdisplaymedia]

### 30. PWA Install + File Handlers + Web Share Target
- **Proves:** Installed PWA opens `.mp4`/`.mov`/`.reelproj` from Finder/
  Explorer via `LaunchQueue`, receives shared files from the OS via Web Share
  Target, and runs offline from a Service Worker shell.
- **Key APIs:** `manifest.file_handlers`, `LaunchQueue.setConsumer`,
  `share_target`, Service Worker, `navigator.share`.
- **Depends on:** exp-01.
- **Complexity:** Low.
- **Why dedicated:** First-class OS integration is what differentiates a
  serious editor from a "demo in a tab"; FileHandling API is Chromium-desktop
  only and has constraints worth proving early.[^pwa-files]

### 31. Snapping Engine + Ripple/Roll/Slip/Slide
- **Proves:** Frame-accurate magnetic snapping (clip edges, playhead, markers,
  beat grid from waveform peaks), with ripple/roll/slip/slide trim primitives
  that update Zustand state at 60 fps with < 16 ms latency on a 500-clip
  timeline.
- **Key APIs:** None (algorithmic), but interacts with `PointerEvent`
  coalescing and `requestAnimationFrame` scheduling.
- **Depends on:** exp-09, exp-25.
- **Complexity:** Medium.
- **Why dedicated:** These are the core editing primitives every NLE has; they
  are non-trivial to implement correctly with linked clips and rippling, and
  they must compose with undo/redo.[^trim-tools]

---

## 3. New web-platform APIs to track (2025–2026)

These shipped or are shipping during the project window and could simplify or
replace pieces of the current 12-experiment stack:

- **WebGPU subgroups (Chrome 134, April 2025).** SIMD-level parallelism inside
  workgroups; 2.3–2.9× wins observed for matrix-vector kernels. Useful for
  exp-11 (background removal), color conversion, optical flow.[^subgroups]
- **WebCodecs orientation metadata (Chrome 137, mid-2025).** `VideoDecoderConfig`
  / `VideoFrame` gain `rotation`/`flip` fields — removes the manual rotate
  pass that exp-03 / exp-04 currently need for portrait phone clips.[^orientation]
- **WebCodecs alpha side-data + SVC `temporalLayerId`.** Encoders can now emit
  alpha as `chunkMetadata.alphaSideData`; SVC layers can be tagged for
  selective drop. Affects export pipeline (exp-10) and proxy workflow.[^alpha-svc]
- **File System Observer (origin trial Chrome 129).** Removes polling of OPFS
  / user-picked directories. Direct fit for exp-19 multi-tab coordination.[^fs-observer]
- **Compute Pressure API (Chrome 125, GPU source in trial).** Drop-in for
  thermal/load-aware quality (exp-27).[^compute-pressure]
- **Long Animation Frames API (Chrome 123).** Better than Long Tasks for an
  NLE because it captures rendering work too (exp-28).[^loaf]
- **WebNN execution provider in onnxruntime-web.** Stable Diffusion in 100 ms
  with WebNN+WebGPU as of April 2026; revisit exp-11 model choices and
  consider promoting WebNN over the WebGPU EP for some ops.[^webnn]
- **Per-frame QP for H.264/HEVC encode (Chrome 135, Feb 2025).** Lets exp-10
  do quality-targeted variable-bitrate without leaving WebCodecs.[^qp]
- **`GPUCanvasContext.configure({ toneMapping })`.** Browser does HDR→SDR
  tone-mapping for you on the canvas; pairs with exp-13.[^webgpu-hdr]

---

## 4. Foot-guns the integration experiment (exp-12) will hit

Documented issues in production write-ups that none of the current 12
experiments explicitly de-risks:

- **VideoFrame VRAM leaks.** Forgetting `close()` in any path (error, abort,
  cache eviction, hot-reload) leaks GPU memory and Chrome will eventually OOM
  the tab. Centralize ownership; lint for it.[^webcodecs-leak]
- **Decoder "traffic jam."** Demuxer feeds `decoder.decode()` faster than the
  decoder drains; `decodeQueueSize` climbs; latency explodes. Need explicit
  backpressure at every pipeline stage. (exp-14)[^remotion-webcodecs]
- **Portrait video silently displays as landscape.** WebCodecs ignored
  rotation metadata until Chrome 137; older Chrome / SW decode paths still
  do. Auto-rotate test in CI matrix.[^orientation]
- **macOS VTDecoderXPCService leaks when tab is in background.** Open W3C
  issue; the WebCodecs decoder process holds memory when the tab is
  backgrounded. Pause decode on `visibilitychange`.[^webcodecs-leak]
- **HEVC support is a per-OS lottery.** Hardware decoder must exist; on Linux
  it is frequently absent; Chrome ships disabled by default in some
  configurations. Probe with `isConfigSupported` and degrade UI.[^hevc-stazhu]
- **OPFS quota silently evicts.** Non-persistent origins can lose everything
  at once; Chrome allocates up to 60% of disk to one origin but the user can
  reclaim it. Always request `persist()` before the first big write.[^mdn-quota]
- **Cross-origin isolation breaks third-party embeds.** Need
  `COOP: same-origin` + `COEP: require-corp` for SharedArrayBuffer (audio
  ring buffer, AudioWorklet WASM). Any analytics/captcha/ads script without
  `Cross-Origin-Resource-Policy` will be blocked. Plan the deployment
  topology now.[^coop-coep]
- **WebGPU device loss on sleep/wake and driver update.** No engine handles
  this gracefully out of the box (Three.js, PlayCanvas, Bevy issues all open
  as of late 2025). exp-15 must build the resource registry from day one.[^bevy-loss]
- **Safari has VideoDecoder but not yet stable AudioDecoder.** Project
  declares Chrome-only, but if scope ever broadens this is a known
  asymmetry.[^remotion-mis]
- **Compositor color space drift.** sRGB canvas + BT.709 video + P3 image +
  user-loaded LUT in unknown space = chain of accidental gamma errors.
  exp-13 exists specifically to nail this down.[^webgpu-hdr]
- **Encoder rotation mid-stream throws.** If exp-10 ever needs to splice
  clips with different orientations into one encoded output, the spec now
  throws a non-fatal exception. Pre-rotate before encode or split sessions.[^orientation]

---

## 5. Sources

- [What's New in WebGPU (Chrome 134) — subgroups](https://developer.chrome.com/blog/new-in-webgpu-134)
- [Compute Pressure API — Chrome for Developers](https://developer.chrome.com/docs/web-platform/compute-pressure)
- [Long Animation Frames API — Chrome for Developers](https://developer.chrome.com/docs/web-platform/long-animation-frames)
- [The File System Observer API origin trial](https://developer.chrome.com/blog/file-system-observer)
- [WebGPU HDR explainer](https://github.com/ccameron-chromium/webgpu-hdr/blob/main/EXPLAINER.md)
- [GPUCanvasContext: configure() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/configure)
- [WebCodecs spec (W3C)](https://www.w3.org/TR/webcodecs/)
- [WebCodecs VideoFrame Metadata Registry](https://w3c.github.io/webcodecs/video_frame_metadata_registry.html)
- [Intent to Ship: VideoFrame orientation metadata (Chrome 137)](https://groups.google.com/a/chromium.org/g/blink-dev/c/pMfpH02OmHE)
- [Clearing up WebCodecs misconceptions — Remotion](https://www.remotion.dev/docs/webcodecs/misconceptions)
- [Processing video with WebCodecs — Remotion](https://www.remotion.dev/docs/media-parser/webcodecs)
- [WebCodecs causing memory leak in macOS VTDecoderXPCService — w3c/webcodecs#885](https://github.com/w3c/webcodecs/issues/885)
- [VideoDecoder.isConfigSupported — MDN](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/isConfigSupported_static)
- [Enable Chromium HEVC hardware decoding — StaZhu](https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding)
- [Storage quotas and eviction criteria — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [Web Locks API — W3C](https://www.w3.org/TR/web-locks/)
- [WebGPU Device Loss best practices — Toji.dev](https://toji.dev/webgpu-best-practices/device-loss.html)
- [Bevy: recover from WebGPU Device Lost — issue #10456](https://github.com/bevyengine/bevy/issues/10456)
- [JavascriptSubtitlesOctopus (libass-WASM)](https://github.com/libass/JavascriptSubtitlesOctopus)
- [Drawing Text in WebGPU — tchayen.com](https://tchayen.com/drawing-text-in-webgpu-using-just-the-font-file)
- [Sub-pixel Distance Transform — Acko.net](https://acko.net/blog/subpixel-distance-transform/)
- [How video games use LUTs — frost.kiwi](https://blog.frost.kiwi/WebGL-LUTS-made-simple/)
- [Bezier keyframe interpolation — Adobe Premiere docs](https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/control-effect-changes-using-bezier-keyframe-interpolation.html)
- [Wasm Audio Worklets — Emscripten docs](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html)
- [waveform-data.js — BBC](https://github.com/bbc/waveform-data.js/)
- [Moonshine vs Whisper ASR (2026) — ModelsLab](https://modelslab.com/blog/audio-generation/moonshine-vs-whisper-asr-real-time-speech-2026)
- [WebNN + ONNX Runtime + WebGPU — scribbler.live](https://scribbler.live/2026/04/02/Stable-Diffusion-in-the-Browser-with-WebNN-ONNX.html)
- [getDisplayMedia — MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [Associate files with your PWA — MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Associate_files_with_your_PWA)
- [Cross-origin isolation (COOP/COEP) — web.dev](https://web.dev/articles/coop-coep)
- [Shotcut: recover an auto-saved project after a crash](https://forum.shotcut.org/t/how-to-manually-recover-an-auto-saved-project-after-a-crash/20814)
- [Premiere Pro ripple/roll/slip/slide tools — Noble Desktop](https://www.nobledesktop.com/learn/premiere-pro/perfecting-your-edits-in-adobe-premiere-pro-the-ripple,-roll,-slip,-and-slide-tools)
- [Mediabunny vs FFmpeg.wasm performance — Dayverse](https://dayverse.id/en/articles/best-ffmpeg-wasm-alternatives-client-side/)
- [AI video upscaler case study — web.dev](https://web.dev/case-studies/ai-video-upscaler-case-study)

[^webgpu-hdr]: WebGPU HDR explainer & MDN GPUCanvasContext.
[^chrome-hdr]: Chromium HEVC HDR support guide — StaZhu repo.
[^remotion-webcodecs]: Remotion "Clearing up WebCodecs misconceptions" — backpressure traffic jam.
[^webcodecs-leak]: w3c/webcodecs#885 (macOS XPC leak); Remotion docs on `close()` discipline.
[^toji-device-lost]: Toji.dev "WebGPU Device Loss best practices."
[^bevy-loss]: bevyengine/bevy#10456.
[^shotcut-recover]: Shotcut forum recovery thread.
[^isconfig]: MDN VideoDecoder.isConfigSupported.
[^hevc-stazhu]: StaZhu enable-chromium-hevc-hardware-decoding.
[^mdn-quota]: MDN Storage quotas and eviction criteria.
[^web-locks]: W3C Web Locks spec & EXPLAINER.md.
[^lut-cube]: frost.kiwi WebGL LUTs guide.
[^subtitles-octopus]: libass/JavascriptSubtitlesOctopus README.
[^use-gpu-text]: Acko.net "Sub-pixel Distance Transform."
[^bezier-keyframes]: Adobe Premiere bezier keyframe documentation.
[^audio-worklet-wasm]: Emscripten Wasm Audio Worklets API; Chrome AudioWorklet design pattern.
[^waveform-data]: bbc/waveform-data.js README.
[^moonshine]: ModelsLab Moonshine vs Whisper benchmark (2026).
[^compute-pressure]: Chrome for Developers Compute Pressure API.
[^loaf]: Chrome for Developers Long Animation Frames.
[^getdisplaymedia]: MDN getDisplayMedia.
[^pwa-files]: MDN Associate files with your PWA.
[^trim-tools]: Noble Desktop Premiere Pro ripple/roll/slip/slide.
[^subgroups]: Chrome 134 release notes — subgroups GA.
[^orientation]: Blink-dev Intent to Ship: VideoFrame orientation metadata.
[^alpha-svc]: w3c/webcodecs Alpha support issues #200/#207; SVC metadata in spec.
[^fs-observer]: Chrome blog File System Observer origin trial.
[^webnn]: scribbler.live Stable Diffusion via WebNN+ONNX+WebGPU (April 2026).
[^qp]: Per-frame QP H.264/HEVC encoding (Chrome 135).
[^coop-coep]: web.dev COOP/COEP article.
[^remotion-mis]: Remotion misconceptions doc — Safari AudioDecoder gap.
