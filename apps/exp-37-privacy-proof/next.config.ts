import type { NextConfig } from "next";

// Content-Security-Policy is the *static* defense-in-depth layer of the
// privacy proof; the service worker in `public/privacy-sw.js` is the *runtime*
// proof that the user watches live in the Network panel. The two are
// complementary: the SW intercepts and blocks cross-origin fetches at request
// time, while the CSP declares the same egress posture to the browser so even
// a fetch the SW missed (or an injected script) cannot phone home.
//
// `connect-src 'self'` — NOT `'none'`. The doc once claimed `'none'`, but a
// global `'none'` would break Next.js same-origin fetches and dev/HMR
// (webpack-hmr websocket, RSC navigations, service-worker registration), so we
// scope egress to the origin. Cross-origin egress is still blocked, which is
// the property the experiment proves; the "Probe a real cross-origin fetch"
// button is refused by both the CSP (statically) and the SW (at runtime).
const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' lets onnxruntime-web / Transformers.js instantiate the
  // ASR WebAssembly. 'unsafe-eval' is only needed in dev for React's debugging.
  `script-src 'self' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  // Tailwind injects inline <style> tags; allow inline styles same-origin.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  // The transcribe worker is created from a same-origin blob: URL.
  "worker-src 'self' blob:",
  // The egress lock: only same-origin connections. In dev we additionally
  // allow ws: for HMR so the app stays usable.
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Keep COOP/COEP intact for SharedArrayBuffer / WebGPU.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
