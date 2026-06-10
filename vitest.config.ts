import { defineConfig } from 'vitest/config'

// Tests live in /tests so they never enter any app's `src` tree — keeping
// `next build` typecheck clean (it must not see vitest imports). Tests import
// pure leaf modules from apps/packages by relative path; anything that touches
// a browser API (WebGPU/WebCodecs/AudioContext) is verified in-browser, not here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
