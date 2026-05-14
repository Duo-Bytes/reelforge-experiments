"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  bindMidi,
  bindHid,
  parseShuttlePro,
  decodeXTouchKnob,
  type ControlEvent,
} from "../lib/controls";

type Lift = { r: number; g: number; b: number };

export default function Page() {
  const [events, setEvents] = useState<ControlEvent[]>([]);
  const [midiPorts, setMidiPorts] = useState<string[]>([]);
  const [hidDevices, setHidDevices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [permState, setPermState] = useState<"idle" | "requesting" | "ok" | "denied">("idle");
  const [lift, setLift] = useState<Lift>({ r: 0, g: 0, b: 0 });
  const [scrubRate, setScrubRate] = useState(0);
  const cleanupRef = useRef<Array<() => void>>([]);

  const log = useCallback((ev: ControlEvent) => {
    setEvents((prev) => [ev, ...prev].slice(0, 200));
  }, []);

  const onMidi = useCallback(
    (ev: ControlEvent) => {
      log(ev);
      const k = decodeXTouchKnob(ev);
      if (k) {
        setLift((prev) => {
          const next = { ...prev };
          if (k.channel === 0) next.r = clamp(prev.r + k.delta * 0.005, -0.5, 0.5);
          if (k.channel === 1) next.g = clamp(prev.g + k.delta * 0.005, -0.5, 0.5);
          if (k.channel === 2) next.b = clamp(prev.b + k.delta * 0.005, -0.5, 0.5);
          return next;
        });
      }
    },
    [log],
  );

  const onHid = useCallback(
    (ev: ControlEvent) => {
      log(ev);
      const sh = parseShuttlePro(ev);
      if (sh) {
        setScrubRate(sh.shuttle);
      }
    },
    [log],
  );

  const requestMidi = useCallback(async () => {
    setError(null);
    setPermState("requesting");
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      const ports: string[] = [];
      access.inputs.forEach((port) => ports.push(port.name ?? port.id));
      setMidiPorts(ports);
      const stop = bindMidi(access, onMidi);
      cleanupRef.current.push(stop);
      setPermState("ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPermState("denied");
    }
  }, [onMidi]);

  const requestHid = useCallback(async () => {
    setError(null);
    try {
      // Contour ShuttlePro v2 / ShuttleXpress filter set. Empty filter list
      // would let the user pick anything; we keep this narrow for now.
      const devices = await navigator.hid.requestDevice({
        filters: [
          { vendorId: 0x0b33, productId: 0x0030 },
          { vendorId: 0x0b33, productId: 0x0020 },
          { vendorId: 0x05f3 },
        ],
      });
      const labels: string[] = [];
      for (const dev of devices) {
        if (!dev.opened) await dev.open();
        labels.push(`${dev.productName} (vid=${hex(dev.vendorId)} pid=${hex(dev.productId)})`);
        const stop = bindHid(dev, onHid);
        cleanupRef.current.push(stop);
      }
      setHidDevices(labels);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [onHid]);

  useEffect(() => () => {
    for (const fn of cleanupRef.current) fn();
    cleanupRef.current = [];
  }, []);

  return (
    <main className="min-h-screen bg-zinc-50 p-8 font-mono text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Exp-36 · Hardware Control Surfaces</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            WebMIDI (e.g. Behringer X-Touch Mini) bound to lift R/G/B.{" "}
            WebHID (Contour ShuttlePro v2) bound to jog/shuttle scrub. No native
            install. Permission prompts gated by user gesture.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">MIDI</h2>
            <button
              type="button"
              onClick={requestMidi}
              disabled={permState === "requesting"}
              className="rounded bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              {permState === "ok" ? "MIDI connected" : "Request MIDI access"}
            </button>
            <div className="mt-3 text-xs text-zinc-500">
              ports: {midiPorts.length ? midiPorts.join(", ") : "—"}
            </div>
          </div>
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">HID</h2>
            <button
              type="button"
              onClick={requestHid}
              className="rounded bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black"
            >
              Pair HID device…
            </button>
            <div className="mt-3 text-xs text-zinc-500">
              devices: {hidDevices.length ? hidDevices.join(", ") : "—"}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">Bound state — lift</h2>
            <div className="space-y-2 text-xs">
              <Bar label="R" value={lift.r} range={0.5} color="rgb(239,68,68)" />
              <Bar label="G" value={lift.g} range={0.5} color="rgb(16,185,129)" />
              <Bar label="B" value={lift.b} range={0.5} color="rgb(59,130,246)" />
            </div>
          </div>
          <div className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <h2 className="mb-2 text-sm font-semibold">Bound state — scrub</h2>
            <div className="text-xs">
              <Bar label="shuttle" value={scrubRate} range={7} color="rgb(250,204,21)" />
              <div className="mt-2 text-zinc-500">
                shuttle ring → variable-rate scrub from −7× to +7×.
              </div>
            </div>
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Event log (latest 200)</h2>
          <div className="max-h-72 overflow-auto rounded bg-zinc-100 p-2 text-[10px] dark:bg-zinc-900">
            {events.length === 0 ? (
              <div className="text-zinc-500">no events yet</div>
            ) : (
              <table className="w-full">
                <thead className="text-zinc-500">
                  <tr><th className="text-left">t</th><th className="text-left">src</th><th className="text-left">data</th></tr>
                </thead>
                <tbody>
                  {events.map((ev, i) => (
                    <tr key={i}>
                      <td>{ev.t.toFixed(1)}</td>
                      <td>{ev.source}</td>
                      <td className="font-mono">{ev.bytes.join(",")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="rounded border border-zinc-300 p-4 text-xs dark:border-zinc-700">
          <h2 className="mb-2 text-sm font-semibold">Next steps</h2>
          <ul className="ml-5 list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>Persist device IDs in IndexedDB and re-bind via <code>navigator.hid.getDevices()</code> on next load.</li>
            <li>Loupedeck Live support: SysEx + a controller-specific parser.</li>
            <li>Wire lift uniforms into exp-04 compositor with no per-keystroke debounce.</li>
            <li>Map ShuttlePro F1-F15 to mark in/out, ripple cut, split, etc.</li>
            <li>Gamepad fallback via the Gamepad API for users without a dedicated controller.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function Bar({ label, value, range, color }: { label: string; value: number; range: number; color: string }) {
  const pct = Math.max(0, Math.min(1, (value + range) / (range * 2)));
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-zinc-500">
        <span>{label}</span>
        <span>{value.toFixed(3)}</span>
      </div>
      <div className="h-1.5 rounded bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full rounded" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function hex(n: number | undefined) {
  return n === undefined ? "?" : `0x${n.toString(16).padStart(4, "0")}`;
}
