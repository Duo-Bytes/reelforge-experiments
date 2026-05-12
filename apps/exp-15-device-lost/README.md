# exp-15 · GPU Device-Lost Recovery

## Purpose

When the WebGPU device is lost — driver update, OS sleep/wake, tab
background eviction — every GPU resource (pipeline, buffer, texture, bind
group) is dead. The editor must rebuild the entire graph and resume.

This experiment builds the resource-registry pattern that survives
indefinite recovery loops, and measures recovery time.

## Architecture

```
GpuRuntime  (src/lib/registry.ts)
├── adapter, device
├── ResourceRegistry           # name → factory(device) → resource
│   ├── shader-module
│   ├── pipeline (depends on shader-module)
│   ├── uniform buffer
│   ├── storage buffer (palette)
│   └── bind group (depends on pipeline, buffers)
├── device.lost.then(onLost)
│   ├── log LossEvent { reason, message, occurredAt }
│   ├── set state = "recovering"
│   ├── adapter.requestAdapter() / requestDevice()
│   ├── new ResourceRegistry; rebuild every factory
│   ├── reconfigure canvas context with new device
│   └── set state = "ready"; record recoveryMs
└── render loop: only renders when state === "ready"
```

The page registers all GPU resources by name through the registry, never
captures a device reference, and looks resources up by name each frame.
After recovery, the same names map to fresh resources on the new device.

## Controls

- **Force loss** — calls `device.destroy()` directly. Equivalent to
  driver crash for the WebGPU runtime.
- **Scripted loss loop** — repeatedly forces a loss every N ms. Lets the
  recovery path soak for hours.

## Live stats

- `recovered` / `failed` counters
- `recovery min / mean / max` in ms
- `state`: `ready · lost · recovering · failed`
- last 10 LossEvents with reason and message

## Success criteria

1. Force-loss button: state cycles ready → lost → recovering → ready
   within ~100–500 ms; render resumes the same frame.
2. Scripted loss loop at 5 s intervals for 5 minutes: zero failures,
   median recovery &lt; 1 s, fps within 10% of baseline between losses.
3. `recoveries` uniform increases by 1 per recovery — proves the storage
   buffer was re-uploaded after rebuild.
4. After repeated forced losses, no validation errors fire on the new
   device (check DevTools console for `uncapturederror` logs).

## Why a registry

- Caller code holds *names*, not device handles. Recovery doesn't require
  updating any callers — they call `registry.get("pipeline")` and always
  get the live one.
- Build order is preserved in insertion order. Dependents are rebuilt
  after dependencies, naturally, because the caller registers in the
  right order.
- Adding a resource is one `register()` call. Forgetting to register
  something fails at first frame, not at recovery — caught loudly.

## Known foot-guns

- The canvas `GPUCanvasContext` does *not* survive device loss either;
  you must `context.configure({ device: newDevice, ... })` after every
  recovery. The page does this in `onRecover`.
- `device.lost` is a one-shot Promise. The new device has its own,
  separate `.lost` Promise — re-attach the handler when rebuilding.
- Avoid recovery storms: if losses come faster than the runtime can
  rebuild, you can flap. The runtime caps at 5 unrecovered losses in
  a 10 s window and goes to `failed` rather than spinning.
- `device.destroy()` resolves `lost` synchronously in some Chrome
  builds; don't assume an await tick exists between `destroy()` and the
  start of recovery.

## Running

```
pnpm --filter exp-15-device-lost dev
```
