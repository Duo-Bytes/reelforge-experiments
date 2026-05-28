declare module "@jitsi/rnnoise-wasm/dist/rnnoise-sync" {
  /** Minimal surface of the Emscripten module we use. */
  export interface RnnoiseModule {
    /** Allocate an RNNoise denoise state. Pass 0 for the default model. */
    _rnnoise_create(model?: number): number;
    _rnnoise_destroy(state: number): void;
    /**
     * Denoise one 480-sample frame in place. `inPtr`/`outPtr` are byte
     * offsets into HEAPF32; samples must be in int16 range. Returns the
     * voice-activity probability for the frame.
     */
    _rnnoise_process_frame(state: number, outPtr: number, inPtr: number): number;
    _malloc(bytes: number): number;
    _free(ptr: number): void;
    HEAPF32: Float32Array;
  }
  const createRNNWasmModuleSync: (options?: Record<string, unknown>) => RnnoiseModule;
  export default createRNNWasmModuleSync;
}
