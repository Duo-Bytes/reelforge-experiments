# Obscure Web Tech for a Browser NLE

> Beyond WebCodecs / WebGPU / OPFS / ONNX. APIs and patterns that are well-supported in Chrome but rarely show up in editor write-ups. Each entry: what it is, why it matters for a video editor, the smallest experiment that would prove it works, the major gotchas.

The 12 core experiments cover the **render pipeline**. This document covers the **editor experience** — collaboration, hardware control, color science, performance instrumentation, project I/O — areas where obscure browser APIs can save weeks of work or unlock features that competitors (even native NLEs) lack.

Triage column: 🔴 high impact / clear win · 🟡 strong but niche · 🟢 cute, save for later.

---

## 1. 🔴 WebGPU compute shaders for color grading

**What.** `GPUComputePipeline` + `@compute @workgroup_size(...)` WGSL kernels. Same device as the render pipeline; outputs into storage textures the fragment shader can read.

**Why for a NLE.** Color grading (LUT 3D, lift/gamma/gain, OCIO transforms) is per-pixel math. Doing it in the fragment shader means recomputing on every render call. A compute shader can pre-bake the LUT-applied frame once into a `GPUTexture` and the compositor samples it cheaply. Also unlocks: scopes (waveform / vectorscope / histogram via parallel reductions), keyer math (chroma key in HSL), motion-blur via temporal accumulation.

**Experiment.** Take an `ImageBitmap` from exp-06's RAM tier, dispatch a 16×16 workgroup compute pass that applies a 33³ LUT to every pixel, write into a storage texture, render with the cached pipeline. Bench against a fragment-shader implementation of the same LUT.

**Gotchas.** `texture_storage_2d<rgba8unorm, write>` requires the `bgra8unorm-storage` feature on macOS (Metal). `@workgroup_size` is hardware-limited — 256 invocations is safe, 1024 only on discrete GPUs. Compute → render barriers are implicit if you submit in order, but not if you submit twice.

---

## 2. 🔴 WebNN API (when shipped)

**What.** [WebNN](https://www.w3.org/TR/webnn/) — a model-graph API that targets the OS's native ML stack: NPUs (Apple Neural Engine, Intel/AMD NPUs, Qualcomm Hexagon) instead of WebGPU. Behind a flag in Chrome 131+, on by default in Edge.

**Why for a NLE.** ONNX-on-WebGPU (exp-11) is great but it competes with the compositor for GPU time. WebNN dispatches inference to the NPU, leaving the GPU free for rendering. On a 2024 MacBook Pro, RMBG-1.4 runs ~3× faster on the ANE than via WebGPU EP, and **doesn't drop frames** in the preview while inferring.

**Experiment.** Same RMBG-1.4 model, same image. Wire `MLContext` and run inference. Compare wall-clock per-frame: WebGPU EP vs WebNN. Verify the GPU is idle during NN dispatch (DevTools → Performance → GPU track).

**Gotchas.** Model graphs must be **manually translated** to WebNN ops — there's no ONNX → WebNN compiler in stable. Use `onnxruntime-web@1.20+` whose WebNN EP does the translation for you (still partial coverage). Falls back silently to WASM if a single op is unsupported.

---

## 3. 🔴 WebRTC Insertable Streams (Encoded Transform)

**What.** [Insertable Streams](https://www.w3.org/TR/webrtc-encoded-transform/). A `RTCRtpScriptTransform` that intercepts encoded frames between the encoder and the network. You get `RTCEncodedVideoFrame` with the raw bitstream chunk in your worker.

**Why for a NLE.** Multi-user collaborative editing where one editor's preview is **streamed to clients** as they edit. Without insertable streams you'd re-encode for streaming; with it you can grab the same `EncodedVideoChunk` you generate for export and hand it to a peer connection. Also: low-latency client review streams without a media server.

**Experiment.** Spin up a localhost peer connection, attach a `RTCRtpScriptTransform` whose script is a worker that takes encoded chunks and rewrites the timestamp + writes them to the wire. Verify a second tab plays the stream with sub-100ms latency.

**Gotchas.** Chrome-only as of 2026 (Firefox now opted-in for 142+). The transform runs in a dedicated worker, not the main thread, and you can't postMessage main-thread state into it without serialization.

---

## 4. 🔴 Storage Buckets API

**What.** [Storage Buckets](https://developer.mozilla.org/en-US/docs/Web/API/StorageBucket). Multiple **separately-quotaed** OPFS-backed storage units per origin.

**Why for a NLE.** Every project gets its own bucket. User can pin a project (`{ persisted: true }`) so the browser won't evict it under storage pressure. When the user "closes" a project, that bucket alone is released, not the entire app's data. Quota and usage are per-bucket, surfaced via `bucket.estimate()`. Solves the "OPFS is one giant pool" pain in the current 12-experiment build.

**Experiment.** Replace the flat `navigator.storage.getDirectory()` calls in exp-01/exp-07/exp-12 with `navigator.storageBuckets.open(projectId)` and `(await bucket.getDirectory())`. Toggle `persisted: true` and watch eviction behavior under DevTools → Application → Storage → "Simulate storage pressure".

**Gotchas.** Available in Chrome 122+ (stable), not yet in Safari/Firefox. `StorageBucket.delete()` is async and irreversible — gate it behind a confirm dialog. Same exclusive-lock semantics as the global OPFS.

---

## 5. 🔴 OffscreenCanvas + ImageBitmapRenderingContext

**What.** `canvas.getContext("bitmaprenderer")` is a third canvas context type alongside 2D and WebGL/WebGPU. Its only operation: `transferFromImageBitmap(bitmap)` — zero-copy display of an `ImageBitmap`.

**Why for a NLE.** Multi-monitor preview, audio-meter strips, scope overlays — all places where you produce an `ImageBitmap` once and want to display it cheaply across N canvases. `bitmaprenderer` does the swap with **zero pixel copies**, unlike `drawImage` (one copy) or WebGPU sample-and-render (one upload + one render pass). Best for "the GPU has already done the work, just show the result".

**Experiment.** In exp-12, mirror the main render canvas to a side-monitor canvas using `bitmaprenderer`. Capture the offscreen output via `canvas.transferToImageBitmap()` once per frame and `transferFromImageBitmap` to all secondary canvases. Bench vs `drawImage(canvas, ...)` mirroring.

**Gotchas.** `transferFromImageBitmap` consumes the bitmap (it becomes detached). Use `createImageBitmap` to clone if multiple consumers want the same frame.

---

## 6. 🔴 View Transitions API (cross-document + same-document)

**What.** `document.startViewTransition(callback)` snapshots the DOM, runs `callback`, snapshots again, and animates between via configurable CSS pseudo-elements. Recently extended to [cross-document navigation](https://developer.chrome.com/docs/web-platform/view-transitions/cross-document) so transitions survive route changes.

**Why for a NLE.** Editor UIs are state-heavy: clip selection, panel resizing, tab switches between sequencer / colorist / audio mix views. View Transitions gives you film-grade UI animation (panel cross-fade, clip-grow on insert, viewport pan-and-zoom on time scrub) for free, *without* JS animation libraries that fight React.

**Experiment.** In exp-09, wrap the "reseed clips" button click in `document.startViewTransition(() => seedClips(n, 8))`. Tag the timeline scroller with `view-transition-name: timeline`. Watch the entire timeline animate from old to new state in one frame.

**Gotchas.** `view-transition-name` must be **unique per element** — generate per-clip names from `clip.id`. The browser captures element snapshots, not pixel rectangles, so 500-clip transitions are O(visible-clips) not O(total).

---

## 7. 🟡 WebMIDI for hardware control surfaces

**What.** `navigator.requestMIDIAccess()` exposes connected MIDI devices. Most pro audio/video controllers (Loupedeck, Stream Deck MIDI mode, X-Touch Mini, Behringer FCB1010, Avid S1) speak MIDI.

**Why for a NLE.** Color grading on a hardware T-bar is 10× more ergonomic than mouse + slider. Same for jog-wheel scrubbing. WebMIDI lets the editor recognize controllers without any native install, drivers, or download.

**Experiment.** Map the X-Touch Mini's 8 rotary encoders to lift/gamma/gain RGB (3+3+3 = 9 — drop one). Subscribe to `MIDIAccess.inputs` change events; per-knob delta drives a Zustand action that mutates color uniforms in the WebGPU pipeline.

**Gotchas.** MIDI requires **secure context** (HTTPS or localhost) and a user permission prompt. Some controllers expose multiple MIDI ports; you have to label-match the right one. SysEx is gated by an extra prompt — only request if you need controller-specific protocols (e.g. Loupedeck Live).

---

## 8. 🟡 WebHID for jog-wheels, gamepads-as-shuttle

**What.** [WebHID](https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API) — direct access to USB HID devices. Lower level than WebMIDI: you get raw input/output reports.

**Why for a NLE.** Devices that aren't MIDI (Contour ShuttlePro, Tangent Wave, Avid MC Color, even an Xbox controller as a shuttle) are HID. The ShuttlePro alone is a $90 win for editors. Game controllers as shuttle/jog: thumbstick = shuttle (variable speed scrub), D-pad = step ±1 frame.

**Experiment.** `navigator.hid.requestDevice({ filters: [{ vendorId: 0x0b33 }] })` to grab a ShuttlePro. Decode the 5-byte report (jog dial position + shuttle ring + 15 buttons). Wire jog dial to playhead seek.

**Gotchas.** Device-specific report descriptors — you'll write per-vendor parsers. Permissions are per-device, not per-vendor; user picks each unit they want to use. Bluetooth HID on macOS often requires re-pairing per origin.

---

## 9. 🔴 Y.js / Automerge CRDT for collaborative editing

**What.** Conflict-free Replicated Data Types. Two editors simultaneously trim the same clip, results merge deterministically without locks. Library-level — Y.js is most mature for browser, Automerge is type-rich.

**Why for a NLE.** The killer feature most browser editors don't dare attempt. Picture: producer adjusts pacing while the colorist tweaks LUTs — both see each other's cursors live. This is Figma's whole pitch translated to video. Critical: timeline state from exp-09 was deliberately Zustand-shaped to make this swap painless.

**Experiment.** Replace the Zustand `clips` Record with a `Y.Map<ClipId, Y.Map<...>>`, expose via `useY` hook. Two browser windows over WebRTC `Y.WebrtcProvider`. Drag a clip in window A, watch it animate in window B with sub-100ms latency.

**Gotchas.** Y.js docs grow forever — design a "snapshot + truncate" strategy for long-running projects. CRDTs guarantee convergence, not the *editor's* business invariants — clip overlap, track type compatibility, etc. still need explicit checks in your store actions.

---

## 10. 🔴 Wake Lock API + Service Worker keep-alive

**What.** `navigator.wakeLock.request("screen")` keeps the screen on. Service-worker-only-presence prevents the tab from being throttled to <1Hz when backgrounded.

**Why for a NLE.** Long exports + long renders. A 30-min export should not slow to a crawl when the user clicks another tab to grab a coffee. Combined: wake lock keeps the system from sleeping; service worker keeps the tab alive at full clock speed. Together = export reliability.

**Experiment.** During exp-10 export, request the wake lock. Register a no-op service worker. Launch a 5-min export, switch to a different tab, return. Verify export finished without progress stalling.

**Gotchas.** Wake lock is auto-released on tab visibility change in some configurations — you have to re-request on `visibilitychange`. Service worker must be registered before the export starts; it has no effect on a tab without a registered SW.

---

## 11. 🟡 Eye Dropper API + OKLCH color picking

**What.** `new EyeDropper().open()` returns an `sRGBHex` string from any pixel on the screen. Pair with the [OKLCH color space](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/oklch) for perceptually uniform color manipulation.

**Why for a NLE.** Color-grading panel needs an eye-dropper for "match this clip's white balance to that one's". Native dialogs can't sample across video — Eye Dropper API can sample anywhere on the visible viewport including the WebGPU canvas. OKLCH is essential for "make this 10% brighter without shifting hue", which sRGB-RGB math gets wrong.

**Experiment.** Bind a button → `new EyeDropper().open()`. Convert the returned sRGB hex to OKLCH via the new CSS `Color` API (`new CSSColorValue("rgb(...)").to("oklch")`). Display lightness/chroma/hue separately so the user can adjust one channel.

**Gotchas.** Eye Dropper requires a user gesture and Chrome 95+. Sampling a WebGPU canvas works only if the canvas isn't `alphaMode: "opaque"` and the page isn't cross-origin embedded.

---

## 12. 🔴 BroadcastChannel + Storage Foundation across tabs

**What.** [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) — same-origin pub/sub, zero setup. Combined with shared OPFS access (each tab opens the same file via `getDirectory()`).

**Why for a NLE.** Multi-tab editor sessions: bins / inspector / timeline / preview each in a separate window. Today's pattern (single SPA) is fine; tomorrow's pattern (detached preview window on a second monitor) needs cross-tab state sync. BroadcastChannel with a 50-line "pub when store mutates" wrapper around Zustand.

**Experiment.** Open exp-12 in two tabs of the same origin. Mutate the store in tab A; subscribe via `new BroadcastChannel("editor")` in tab B. Verify state replicates within 5ms.

**Gotchas.** No history / replay — late joiners must read full state on connect. Don't broadcast the playhead (60Hz × N tabs = bandwidth waste); broadcast user actions and let each tab compute its playhead locally.

---

## 13. 🟡 WebAssembly SIMD + bulk-memory for custom filters

**What.** `i32x4`, `f32x4` SIMD intrinsics in WebAssembly, accessible via Rust+`packed_simd` or hand-written `.wat`. Bulk memory operations (`memory.copy`, `memory.fill`) for fast pixel buffer manipulation.

**Why for a NLE.** Some operations don't fit GPU compute well — bilateral noise filtering with content-adaptive kernels, audio FFT analysis on the main thread, or any algorithm that's branch-heavy per-pixel. WASM SIMD is 4–8× faster than scalar JS for these and runs on the CPU so it doesn't compete with the WebGPU pipeline.

**Experiment.** Compile a Rust median-filter for noise reduction. Apply to a `Float32Array` of mask values from exp-11 to clean up jagged edges. Bench vs scalar JS.

**Gotchas.** Increases bundle size — even a small filter can be 50–100KB. WASM threads (parallel SIMD) require COOP/COEP (which we already have). Debugging is hard; build with `wasm-pack` + `console_error_panic_hook` for sanity.

---

## 14. 🟡 Permissions API + Storage Pressure detection

**What.** `navigator.permissions.query()` for fine-grained permission state without prompting; `navigator.storage.estimate()` for current usage and `navigator.storage.persist()` for "don't evict my data".

**Why for a NLE.** Surface to the user "you have 8GB of project data, browser may evict it; click to persist". Predict OPFS quota exhaustion before the export fails. Detect when the user has revoked the screen-recording permission mid-session.

**Experiment.** Add a header-bar widget that polls `storage.estimate()` once a minute and warns at 80% usage. Add a "make project permanent" button calling `storage.persist()`.

**Gotchas.** `estimate()` returns *total origin* usage, not per-bucket — so combine with Storage Buckets (#4) for granular numbers. `persist()` may silently return false; check the boolean.

---

## 15. 🟢 CompressionStreams for project file zip

**What.** Native `CompressionStream` and `DecompressionStream` (gzip / deflate / deflate-raw). Zero-dependency `.zip`-style archive creation by wrapping in a custom container.

**Why for a NLE.** Project export (`.reelforge.zip` containing timeline JSON + thumbnails + LUTs) without bundling JSZip's 100KB. Compresses better than rolling-your-own. Streaming = constant memory regardless of project size.

**Experiment.** `pipeThrough(new CompressionStream("gzip"))` on a JSON-serialized timeline + thumbnails, write to OPFS via the streaming `WritableStream` adapter. Verify Finder/Explorer can extract.

**Gotchas.** Doesn't include the ZIP central directory header — you need to write that yourself if you want native OS extractability. For internal-only `.reelforge` files, a single gzip blob is simpler.

---

## 16. 🟡 WebTransport for low-latency project sync

**What.** [WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport) — HTTP/3 + QUIC bidirectional streams + datagrams. Replaces WebSockets for high-throughput, multiplexed, ordered-or-unordered transport.

**Why for a NLE.** CRDT updates from #9 ride on this nicely — datagrams for cursor positions (no resend if dropped), streams for clip-edit ops (must arrive in order). One TCP-style connection, two transport modes.

**Experiment.** Stand up a Cloudflare Worker / Bun WebTransport server. Send `Y.Doc` updates as datagrams; receive on peer. Compare round-trip vs WebSockets.

**Gotchas.** Server stack is younger than WebSockets — Node's native support is in 23+, Cloudflare added it in 2025. Some corporate firewalls block UDP outbound, killing QUIC.

---

## 17. 🟢 Performance Observer API + User Timing for instrumentation

**What.** `new PerformanceObserver()` to subscribe to long-task / layout-shift / paint events. `performance.mark()` and `performance.measure()` to label custom timeline regions visible in DevTools Performance.

**Why for a NLE.** Instead of `console.log("decode took N ms")`, drop `performance.mark("decode-start")` in the decode worker — it shows up as a colored band in DevTools timeline. Critical for diagnosing the kind of sub-frame cascades that matter at 60fps.

**Experiment.** Wrap every worker postMessage path in `mark`/`measure` pairs. Open DevTools Performance, record a 5s playback, observe per-frame breakdown of decode → render → display.

**Gotchas.** Marks are global per-worker — name them with prefixes (`decode:gop-fetch`) to avoid collision. Long-task observer fires for any task > 50ms on the registering thread — main-thread only by default; workers each need their own observer.

---

## 18. 🟢 Codec strings beyond avc1 — av01, vp09, hev1, vvc1

**What.** Detailed codec parameter strings: `"av01.0.04M.10"` (AV1 Main, level 4, 10-bit), `"hev1.1.6.L93.B0"` (HEVC Main, level 3.1), `"vvc1.1.L51.CYA.O1+1"` (VVC main 5.1 — H.266).

**Why for a NLE.** Source files won't always be AVC. AV1 hardware decode is shipping on most 2024+ machines (Intel ARC, AMD RDNA3, Apple M3+). VVC is starting to appear in pro cameras. The compositor stays the same; only the decoder configure call changes.

**Experiment.** Parse codec strings from arbitrary mp4 files in exp-02, list which `VideoDecoder.isConfigSupported({codec})` accepts on the current machine. Build a compatibility matrix.

**Gotchas.** Codec string parsers are brittle (different boxes for different codecs). Use mediabunny's `getDecoderConfig()` which handles this for you. Hardware decoder support is matrix'd: avc1 universal, av01 most modern GPUs, vvc1 only software decode in Chrome until 2026+.

---

## 19. 🟡 OffscreenCanvas → captureStream → WebRTC for live preview

**What.** `offscreenCanvas.transferToImageBitmap()` doesn't directly produce a `MediaStream` — but a regular `<canvas>` does via `canvas.captureStream(fps)`. Round-trip: render in worker, mirror to a `bitmaprenderer` canvas (#5), capture stream from that.

**Why for a NLE.** Stream the editor preview to a phone / tablet for handheld review without leaving the browser. Combine with WebRTC Insertable Streams (#3) for end-to-end encoded routing.

**Experiment.** In exp-05, mirror the OffscreenCanvas output to a hidden `<canvas>` via `bitmaprenderer`, call `canvas.captureStream(30)`, attach to a `RTCPeerConnection.addTrack`. Receive on a phone tab.

**Gotchas.** `captureStream` framerate is best-effort. Bitmaprenderer-mirrored canvases sometimes captureStream as black on Linux/Wayland. Don't rely on this for export — use the proper VideoEncoder path.

---

## 20. 🔴 File System Observer API (origin trial)

**What.** [File System Observer](https://developer.chrome.com/blog/file-system-observer) — observe a `FileSystemDirectoryHandle` for changes (file added / removed / modified) outside the page's own writes. Origin trial in Chrome 130+.

**Why for a NLE.** "Watch folder" workflow: user picks an SD card directory; new clips dropped in by the camera show up automatically in the bin. Today this requires polling `getDirectoryHandle()` results. Observer API gives push notifications.

**Experiment.** `await dirHandle.observe({ recursive: true })`, log every change. Drop a new file into the directory in Finder, verify the event fires.

**Gotchas.** Origin trial token required (one-line meta tag). May break / move in future versions. Doesn't work on OPFS yet — only user-picked directories from `showDirectoryPicker()`.

---

## 21. 🟡 Picture-in-Picture API for floating preview

**What.** `videoElement.requestPictureInPicture()` opens an OS-level floating window. Document Picture-in-Picture (`documentPictureInPicture.requestWindow()`) does the same for arbitrary HTML.

**Why for a NLE.** Detached preview window — user keeps the editor full-screen on the laptop and the preview floats over a Slack call on the second monitor. Document PiP lets you embed scope overlays alongside the video.

**Experiment.** Pipe the OffscreenCanvas via `captureStream` into a hidden `<video>`, call `requestPictureInPicture()`. Verify the floating window plays. Then try Document PiP with the same `<video>` plus an audio meter.

**Gotchas.** PiP requires user gesture. Some OS configurations (macOS Stage Manager) constrain PiP positioning. Document PiP is Chrome-only as of 2026.

---

## 22. 🟢 navigator.gpu.wgslLanguageFeatures + subgroups

**What.** WGSL language version detection + the [subgroups extension](https://www.w3.org/TR/WGSL/#subgroup-builtin-functions) (warp-level reductions, shipping in Chrome 125+).

**Why for a NLE.** Histogram / waveform scopes via parallel reduction. Subgroup-level `subgroupAdd`, `subgroupBallot` collapse what would be a multi-pass tree reduction into a single dispatch. ~3× faster scope rendering.

**Experiment.** Histogram a 1080p frame using one compute pass with `enable subgroups;` and `subgroupAdd`. Compare against a naive workgroup-shared-memory reduction.

**Gotchas.** `enable subgroups;` directive crashes shader compilation if the device doesn't expose the feature. Always check `device.features.has("subgroups")` first and fall back. Subgroup size differs per vendor (32 NVIDIA, 64 AMD, 32 Apple) — write code that's invariant.

---

## 23. 🔴 Origin Private File System with FileSystemSyncAccessHandle.read offset+length pattern (already used) + write-ahead log for crash safety

**What.** Pattern, not API. Append-only log of project mutations to a separate OPFS file; periodic snapshot consolidation. On startup, replay log to recover.

**Why for a NLE.** The user crashes mid-edit — Premiere does this gracefully via auto-save; browsers historically don't. With OPFS we can build the same. Every Zustand action serialized as a JSON line into `project.log`; once a minute, snapshot + truncate.

**Experiment.** Wrap exp-09's Zustand store in a middleware that writes each action to an OPFS append log. Crash the tab (`window.location = "about:crashed"`). Reload, replay the log to reach the same state.

**Gotchas.** `SyncAccessHandle.write()` with `at: getSize()` is the append. Worker-only. Don't fsync per action (slow); batch every N or every 100ms.

---

## 24. 🟡 WebUSB for capture cards + camera control

**What.** `navigator.usb.requestDevice()` exposes raw USB control transfers. Some prosumer capture cards (Magewell USB Capture HDMI) and PTZ camera control protocols (VISCA-over-USB) speak over USB.

**Why for a NLE.** Live ingest from a capture card directly into the browser — no native driver, no broadcaster software. Plus camera-control sliders for connected cameras (zoom / focus / iris).

**Experiment.** Enumerate connected USB devices, find a capture card, send the vendor's "start streaming" control transfer, decode the YUYV frames over bulk endpoints into VideoFrames.

**Gotchas.** Vendor-specific protocols — much harder than HID. Linux often needs a udev rule to allow non-root access. macOS blocks WebUSB on cameras claimed by another app.

---

## 25. 🔴 Generative AI as part of the pipeline: WebGPU diffusion + Whisper

**What.** Stable Diffusion XL Turbo runs in 2–4s/image via WebGPU EP (e.g. `mlc-ai/web-stable-diffusion`). Whisper-tiny / whisper-base run in WebGPU via [transformers.js](https://huggingface.co/docs/transformers.js) for in-browser transcription.

**Why for a NLE.** Auto-caption every clip on import (Whisper). Generate B-roll placeholders from text prompts (SD). Real-time speech-to-subtitles preview on the playhead. All client-side, no API cost.

**Experiment.** On clip import, kick off a Whisper transcription side-job in a worker. Render the resulting SRT as a subtitle track on the timeline. Bench vs a paid API endpoint.

**Gotchas.** Models are large (Whisper-tiny 75MB, SD-XL Turbo 2GB). Use Cache API (#11). Quantization (INT8) is mandatory for laptop-class GPUs.

---

## 26. 🟢 Anchor positioning + CSS scroll-driven animations for the timeline

**What.** [CSS anchor positioning](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning) and [`animation-timeline: scroll(...)`](https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline) — pure CSS for "this thing follows this other thing" and "drive an animation by scroll position".

**Why for a NLE.** Hover a clip → tooltip anchored exactly to clip top, no JS positioning math. Timeline ruler ticks animate as you scroll horizontally — no rAF loop needed.

**Experiment.** Replace any JS-driven tooltip positioning in exp-09's timeline with CSS anchors. Make the timeline-ruler labels pulse on viewport-enter via scroll-driven animation.

**Gotchas.** Both are Chrome 125+ stable / Safari 26+ — feature-detect with `@supports`. Scroll-driven animations on transformed elements have some quirks on older Safari.

---

## 27. 🔴 Compute-shader audio analysis for FFT-based scopes

**What.** Run a Cooley-Tukey FFT in WGSL compute. Input: SAB-shared audio buffer from exp-08. Output: magnitude spectrum to a `texture_storage_2d`.

**Why for a NLE.** Spectrogram view, spectral noise reduction, vocal isolation pre-pass — all need FFT. Doing it on the GPU with the audio data already in a SAB makes it free vs the CPU FFT libraries (~5ms for a 2048-bin FFT on CPU, ~0.5ms on GPU).

**Experiment.** Take 1024-sample windows from exp-08's ring buffer, copy to a `GPUBuffer`, run a 10-stage radix-2 FFT compute pass, render the magnitude into a spectrogram texture.

**Gotchas.** FFT in WGSL is tricky to write correctly — start from a known-good shader (e.g. WebGPU samples). Floating-point precision: WGSL `f32` is fine for typical audio, but some browsers default to `f16` storage in compute — declare explicitly.

---

## 28. 🟡 Cross-Origin Iframe sandbox for plugin system

**What.** `<iframe sandbox="allow-scripts" src="blob:..." />` running third-party plugin code in a process-isolated frame. Communicate via `postMessage`. With `allow-storage-access-by-user-activation` and feature policies, the plugin can use a scoped subset of APIs.

**Why for a NLE.** Plugin marketplace — third-party color presets, transition packs, AI models — running safely without compromising the editor's data. The plugin gets only the textures and audio you postMessage to it.

**Experiment.** Build a plugin manifest format. Load plugin into a sandboxed iframe; expose a single API (`registerEffect(name, processFrame)`). Test that the iframe can't reach OPFS or IndexedDB of the parent.

**Gotchas.** sandbox attribute alone isn't enough — site-isolation requires the iframe load from a different origin (e.g. `plugin-{id}.editor-plugins.example.com`). Browsers may grant the iframe a separate process only on different origins, not different paths.

---

## 29. 🟡 Web Speech API for voice command

**What.** `SpeechRecognition` (interim Chrome-prefixed `webkitSpeechRecognition`) for live transcription; `SpeechSynthesis` for TTS.

**Why for a NLE.** Voice-controlled editing during long sessions ("split clip", "go to 30 seconds", "show me last 30 seconds"). Some users prefer it; many find it gimmicky. Cheap to add as a power-user toggle.

**Experiment.** Recognize ~10 command phrases mapping to existing keyboard shortcuts. Use grammar hints (`SpeechGrammarList`) for accuracy.

**Gotchas.** Chrome's `SpeechRecognition` sends audio to Google's cloud — privacy concern that violates the "all on-device" principle. Use Whisper (#25) for an on-device alternative.

---

## 30. 🔴 Trusted Types + CSP for plugin safety

**What.** [Trusted Types](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/Trusted-Types). Forces all DOM injection points (`innerHTML`, `Function()`, etc.) through a sanitization policy.

**Why for a NLE.** Editor projects are user-authored data. A malicious project file could include a `<script>` tag in a clip label that executes when rendered. Trusted Types + a strict CSP makes this categorically impossible.

**Experiment.** Add `Content-Security-Policy: require-trusted-types-for 'script';` header. Wrap any `dangerouslySetInnerHTML` (none in current experiments — keep it that way) through a `trustedTypes.createPolicy(...)` policy.

**Gotchas.** Some libraries (older versions of React Markdown, etc.) violate Trusted Types and need sanitizer wrappers. Catch in dev with `report-only` mode before going hard.

---

## How to use this list

I'd start with **#1, #4, #5, #9, #10, #20, #25, #27** — biggest editor-quality wins for a single afternoon of experimentation each. **#2, #3, #16, #17, #28, #30** are infrastructure: implement once and ride for years. Save **#7, #8, #21, #24, #26** for after the core editor ships.

Each entry is a candidate experiment app: `apps/exp-13-...` and onwards. Same shape as exps 01–12 (Next.js + worker + page + README) so the muscle memory transfers.
