/// <reference lib="webworker" />
/**
 * On-device voice isolation / denoise worker for exp-33.
 *
 * Runs RNNoise (a recurrent-network speech denoiser, the same model
 * shipped in Discord/Jitsi) compiled to WASM. The DSP lives entirely
 * inside the binary; we only feed it 480-sample frames at 48 kHz. The
 * sync build inlines the wasm as base64, so nothing is fetched and no
 * audio ever leaves the machine.
 *
 * DeepFilterNet3 (ONNX, WebGPU EP) is a higher-quality upgrade path, but
 * it needs a bespoke ERB / complex-spectrogram feature pipeline with
 * stateful GRUs — see README. RNNoise gives a real, robust baseline now.
 */

import createRNNWasmModuleSync, {
  type RnnoiseModule,
} from "@jitsi/rnnoise-wasm/dist/rnnoise-sync";

const FRAME = 480; // RNNoise fixed frame size at 48 kHz (10 ms).
const INT16 = 0x8000;

type RunMsg = { type: "RUN"; id: number; pcm48k: Float32Array };

let mod: RnnoiseModule | null = null;

function getModule(): RnnoiseModule {
  if (!mod) mod = createRNNWasmModuleSync();
  return mod;
}

self.onmessage = (e: MessageEvent<RunMsg>) => {
  if (e.data.type !== "RUN") return;
  const { id, pcm48k } = e.data;
  try {
    const m = getModule();
    const state = m._rnnoise_create(0);
    const ptr = m._malloc(FRAME * 4);
    const base = ptr >> 2; // HEAPF32 index

    const out = new Float32Array(pcm48k.length);
    let vadSum = 0;
    let vadFrames = 0;
    const frame = new Float32Array(FRAME);

    for (let off = 0; off < pcm48k.length; off += FRAME) {
      const n = Math.min(FRAME, pcm48k.length - off);
      // Scale to int16 range; zero-pad the final partial frame.
      for (let i = 0; i < FRAME; i++) {
        frame[i] = i < n ? pcm48k[off + i] * INT16 : 0;
      }
      m.HEAPF32.set(frame, base);
      const vad = m._rnnoise_process_frame(state, ptr, ptr);
      vadSum += vad;
      vadFrames += 1;
      // HEAPF32 may have grown; re-read the view each frame.
      const heap = m.HEAPF32;
      for (let i = 0; i < n; i++) {
        out[off + i] = heap[base + i] / INT16;
      }
      if ((off / FRAME) % 256 === 0) {
        self.postMessage({
          type: "PROGRESS",
          id,
          done: off,
          total: pcm48k.length,
        });
      }
    }

    m._free(ptr);
    m._rnnoise_destroy(state);

    self.postMessage(
      {
        type: "RESULT",
        id,
        denoised: out,
        avgVad: vadFrames ? vadSum / vadFrames : 0,
      },
      [out.buffer],
    );
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};
