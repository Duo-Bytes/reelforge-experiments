# Exp-38 · Plugin / Effect SDK (WGSL Hot-Reload Sandbox)

## Goal

Define a plugin format (WGSL shader + typed param schema + JS bindings)
and prove the editor can load a plugin from a URL or local file, run it
in a worker-isolated sandbox, expose its parameters through the keyframe
system (exp-23), and **hot-reload under 200 ms** when the local WGSL
file changes on disk.

## App Location

`apps/exp-38-plugin-sdk/`

## Why This Matters — Competitive Edge

Plugin marketplaces are the only durable moat once a creator tool
reaches feature parity (Figma community files, Premiere → Boris FX,
DaVinci → DCTL). Adobe deliberately gates plugin SDKs to native builds;
no browser editor offers a plugin model at all.

Building the marketplace on a WGSL substrate competitors cannot easily
replicate — and shipping a first-class hot-reload developer experience
— is the long-term play. See
[`research-competitive-edge.md`](./research-competitive-edge.md) §38.

## Plugin format (v0)

```
my-plugin/
├── plugin.json          # name, version, schema, entry points
├── shader.wgsl          # fragment / compute entry
└── bindings.ts          # optional: pre/post hooks, parameter glue
```

`plugin.json`:

```jsonc
{
  "id": "com.example.glow",
  "name": "Glow",
  "version": "0.1.0",
  "kind": "filter",
  "entry": { "shader": "./shader.wgsl", "bindings": "./bindings.ts" },
  "params": [
    { "id": "radius",    "type": "f32",  "default": 8.0,  "range": [0, 64] },
    { "id": "intensity", "type": "f32",  "default": 1.0,  "range": [0, 4] },
    { "id": "tint",      "type": "vec3", "default": [1, 1, 1] }
  ]
}
```

Bindings module exports a default object:

```ts
export default {
  beforeCompile(wgsl: string): string { /* preprocessor */ },
  beforeDispatch(ctx: PluginContext): void { /* set uniforms */ },
};
```

## Key APIs

| API | Where used |
|---|---|
| `Worker` (module type, with structured-clone of plugin) | Sandbox |
| `WebAssembly.Module` (future) | Optional CPU plugin path |
| Dynamic `import()` of a Blob URL | Load `bindings.ts` |
| `FileSystemObserver` (Chrome 129+ origin trial) | Hot-reload from local dir |
| `device.createShaderModule({ code })` + compilation hints | Recompile WGSL |
| WGSL preprocessor (regex or simple lexer) | Param-uniform injection |
| `device.destroy()` | Kill-switch on misbehaving plugin |

## Sandbox boundaries

- Plugin code runs in a dedicated `Worker` with no `postMessage` access
  to the main thread's Zustand store. The host posts uniform updates to
  the plugin worker, never the reverse.
- Plugin worker holds a child `GPUDevice` via shared adapter; if it
  hangs or its WGSL fails to compile in 1 s, the host kills the worker.
- No `fetch`, no `WebSocket`, no `localStorage` from the plugin worker
  (CSP `connect-src 'none'` on the worker scope; service worker drops
  any storage attempts).
- Plugin params are validated against the JSON Schema at load and on
  every keyframe update.

## Success Criteria

1. Drag a plugin folder into the page; the editor mounts the plugin and
   shows its param sliders within 500 ms.
2. Editing the WGSL file in an external editor triggers a hot-reload;
   the new shader is composited in **under 200 ms** without losing the
   playhead.
3. A deliberately broken plugin (infinite-loop WGSL, missing param) is
   rejected with a structured error and does not crash the host's
   compositor.
4. The plugin's params can be keyframed via exp-23 (cubic bezier) and
   the values animate at preview framerate.
5. Heap snapshot stable across 50 plugin load/unload cycles — no GPU
   resource leaks (verified via exp-14 backpressure harness).

## Foot-guns

- WGSL is not a sandboxed language. An infinite loop will hang the GPU
  for the whole tab. Mitigation: 1-second pipeline-compile timeout, a
  per-dispatch GPU watchdog, and an immediate `device.destroy()` on the
  plugin worker when watchdog fires.
- `FileSystemObserver` is origin-trial in Chrome 129+; fall back to
  polling `getFile().lastModified` if the API is absent.
- Bindings can do anything a Worker script can do — minimise the surface
  by passing them an explicit, narrow `PluginContext` interface and
  proxy-trapping unexpected access.
- WGSL parameter injection must escape user-supplied strings — a plugin
  name like `glow"; @group(2) @binding(0) ...` would otherwise inject
  bind groups.
- Cache plugin WGSL compilation by content hash in IndexedDB; cold-load
  shader compile can be > 50 ms.

## Demo

- "Open Plugin Folder" picker (uses File System Access API
  `showDirectoryPicker`).
- A demo plugin (a tunable bloom) is shipped in `examples/`. Editing
  `shader.wgsl` in any editor visibly hot-reloads.
- "Break it" button injects a bad WGSL; UI shows the structured error
  and the plugin gracefully unmounts.
- Param sliders bound to the timeline; keyframes (exp-23) recorded and
  played back.
