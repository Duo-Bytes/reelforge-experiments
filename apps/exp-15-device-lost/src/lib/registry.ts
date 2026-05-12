// Resource registry.
//
// Every GPU resource (pipeline, buffer, texture, sampler, bind-group) in
// the app is created via a factory callback registered here. On device
// loss, GpuRuntime.recover() requests a fresh adapter+device and replays
// every registered factory to rebuild the full resource graph.
//
// This is the pattern Bevy/Three.js/PlayCanvas still struggle to ship: the
// app code holds *names*, the registry holds *factories*, and indirection
// through `get(name)` means caller code keeps working after recovery.

export type ResourceKind =
  | "pipeline"
  | "buffer"
  | "texture"
  | "sampler"
  | "bind-group"
  | "shader-module";

export type ResourceFactory<T> = (device: GPUDevice) => T;

export type Resource<T = unknown> = {
  name: string;
  kind: ResourceKind;
  factory: ResourceFactory<T>;
  // Resources may depend on other resources (e.g. bind groups depend on
  // buffers and textures). Dependencies are recreated first.
  deps: string[];
};

export class ResourceRegistry {
  private resources = new Map<string, Resource>();
  private instances = new Map<string, unknown>();
  private buildOrder: string[] = [];

  register<T>(name: string, kind: ResourceKind, deps: string[], factory: ResourceFactory<T>): void {
    if (this.resources.has(name)) {
      throw new Error(`resource already registered: ${name}`);
    }
    this.resources.set(name, { name, kind, factory, deps });
    this.buildOrder.push(name);
  }

  build(device: GPUDevice): void {
    this.instances.clear();
    // Resources are inserted in dependency-respecting order by the caller
    // (we don't do a real topological sort; the caller registers in order).
    for (const name of this.buildOrder) {
      const r = this.resources.get(name);
      if (!r) continue;
      try {
        const inst = r.factory(device);
        this.instances.set(name, inst);
      } catch (err) {
        throw new Error(
          `failed to build ${r.kind} "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  get<T>(name: string): T {
    const inst = this.instances.get(name);
    if (inst === undefined) {
      throw new Error(`resource "${name}" not built`);
    }
    return inst as T;
  }

  size(): number {
    return this.resources.size;
  }
}

export type LossEvent = {
  reason: string;
  message: string;
  occurredAt: number;
  recoveredAt: number | null;
  recoveryMs: number | null;
  resourcesRebuilt: number;
};

export type RuntimeListener = {
  onState?: (state: "ready" | "lost" | "recovering" | "failed") => void;
  onLoss?: (e: LossEvent) => void;
  onRecover?: (e: LossEvent) => void;
};

export class GpuRuntime {
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private registry = new ResourceRegistry();
  private listeners: RuntimeListener = {};
  private intentionalDestroy = false;
  private state: "ready" | "lost" | "recovering" | "failed" = "ready";
  private events: LossEvent[] = [];
  // Build callback re-registers resources on every recovery. Resources from
  // the previous device are dead, so we wipe the registry first.
  private buildCallback: ((reg: ResourceRegistry) => void) | null = null;

  on(listeners: RuntimeListener): void {
    this.listeners = { ...this.listeners, ...listeners };
  }

  setBuild(build: (reg: ResourceRegistry) => void): void {
    this.buildCallback = build;
  }

  async init(): Promise<void> {
    if (!navigator.gpu) throw new Error("WebGPU not supported");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("no adapter");
    this.adapter = adapter;
    const device = await adapter.requestDevice();
    this.attach(device);
    this.buildAll();
    this.setState("ready");
  }

  getDevice(): GPUDevice {
    if (!this.device) throw new Error("no device");
    return this.device;
  }

  getRegistry(): ResourceRegistry {
    return this.registry;
  }

  getEvents(): LossEvent[] {
    return this.events;
  }

  getState(): typeof this.state {
    return this.state;
  }

  // Force a loss for testing. Real loss happens on driver crash, OS sleep,
  // or background-tab eviction.
  forceLoss(): void {
    if (!this.device || this.state !== "ready") return;
    this.intentionalDestroy = true;
    this.device.destroy();
  }

  private attach(device: GPUDevice): void {
    this.device = device;
    void device.lost.then((info) => this.onLost(info));
    // uncapturederror listens for validation errors that don't throw —
    // these accumulate before the device may be lost; logging helps debug.
    device.addEventListener("uncapturederror", (e) => {
      const err = (e as GPUUncapturedErrorEvent).error;
      // eslint-disable-next-line no-console
      console.warn("uncapturederror:", err.message);
    });
  }

  private async onLost(info: GPUDeviceLostInfo): Promise<void> {
    const reason = this.intentionalDestroy
      ? "intentional-destroy"
      : info.reason || "unknown";
    const msg = info.message || "(no message)";
    this.intentionalDestroy = false;
    const occurredAt = performance.now();

    const ev: LossEvent = {
      reason,
      message: msg,
      occurredAt,
      recoveredAt: null,
      recoveryMs: null,
      resourcesRebuilt: 0,
    };
    this.events.push(ev);
    this.setState("lost");
    this.listeners.onLoss?.(ev);

    // Per the spec, do not try to recover when reason === "destroyed" if it
    // was due to the page being closed. We can't tell the difference, so
    // attempt and let failure speak. Avoid infinite recovery storms by
    // capping at 5 attempts in a 10s window.
    const recentFailures = this.events
      .filter((e) => occurredAt - e.occurredAt < 10_000 && e.recoveredAt === null)
      .length;
    if (recentFailures > 5) {
      this.setState("failed");
      return;
    }

    this.setState("recovering");
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("no adapter on recovery");
      this.adapter = adapter;
      const device = await adapter.requestDevice();
      this.attach(device);
      // Wipe and rebuild every registered resource.
      this.registry = new ResourceRegistry();
      this.buildAll();

      ev.recoveredAt = performance.now();
      ev.recoveryMs = ev.recoveredAt - occurredAt;
      ev.resourcesRebuilt = this.registry.size();
      this.setState("ready");
      this.listeners.onRecover?.(ev);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("recovery failed:", err);
      this.setState("failed");
    }
  }

  private buildAll(): void {
    if (!this.buildCallback || !this.device) return;
    this.buildCallback(this.registry);
    this.registry.build(this.device);
  }

  private setState(s: typeof this.state): void {
    this.state = s;
    this.listeners.onState?.(s);
  }
}
