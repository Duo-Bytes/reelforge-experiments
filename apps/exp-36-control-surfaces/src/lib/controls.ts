// Control-surface plumbing for exp-36.
//
// MIDI: bind every input port's onmidimessage and forward to a callback.
// HID:  bind every device's oninputreport.
// Decoders below cover the Behringer X-Touch Mini (MIDI CC) and the
// Contour ShuttlePro v2 (HID input reports). More vendors slot in as
// thin per-device parser functions.

export type ControlEvent = {
  t: number;             // performance.now()
  source: string;        // "midi:<port>" or "hid:<product>"
  bytes: number[];       // raw payload
};

export function bindMidi(access: MIDIAccess, onEvent: (e: ControlEvent) => void): () => void {
  const handlers: Array<[MIDIInput, (e: MIDIMessageEvent) => void]> = [];
  access.inputs.forEach((port) => {
    const handler = (e: MIDIMessageEvent) => {
      onEvent({
        t: performance.now(),
        source: `midi:${port.name ?? port.id}`,
        bytes: e.data ? Array.from(e.data) : [],
      });
    };
    port.addEventListener("midimessage", handler);
    handlers.push([port, handler]);
  });
  return () => {
    for (const [port, handler] of handlers) port.removeEventListener("midimessage", handler);
  };
}

export function bindHid(device: HIDDevice, onEvent: (e: ControlEvent) => void): () => void {
  const handler = (e: HIDInputReportEvent) => {
    const arr: number[] = new Array(e.data.byteLength);
    for (let i = 0; i < e.data.byteLength; i++) arr[i] = e.data.getUint8(i);
    onEvent({
      t: performance.now(),
      source: `hid:${device.productName}`,
      bytes: [e.reportId, ...arr],
    });
  };
  device.addEventListener("inputreport", handler);
  return () => device.removeEventListener("inputreport", handler);
}

// X-Touch Mini in MC mode sends rotary moves as CC 16..23 with a value
// where 0x40 means "center", deltas are signed offset from 0x40.
// In default MIDI mode the encoders send CC 0x01..0x08 with relative values:
// 0x01..0x07 = +N, 0x41..0x47 = -N. Handle both.
export function decodeXTouchKnob(ev: ControlEvent): { channel: number; delta: number } | null {
  if (!ev.source.startsWith("midi:")) return null;
  const [status, controller, value] = ev.bytes;
  if (status === undefined) return null;
  if ((status & 0xf0) !== 0xb0) return null; // not a CC
  if (controller >= 0x10 && controller <= 0x17) {
    return { channel: controller - 0x10, delta: value - 0x40 };
  }
  if (controller >= 0x01 && controller <= 0x08) {
    const sign = value & 0x40 ? -1 : 1;
    return { channel: controller - 0x01, delta: sign * (value & 0x3f) };
  }
  return null;
}

// ShuttlePro v2 8-byte report:
// byte 0 = jog wheel position (rolls 0..255)
// byte 1 = shuttle ring (signed −7..+7)
// bytes 2..3 = packed button bitmap
export function parseShuttlePro(ev: ControlEvent): { jog: number; shuttle: number; buttons: number } | null {
  if (!ev.source.startsWith("hid:")) return null;
  if (!ev.source.toLowerCase().includes("shuttle")) return null;
  const [, jog, shuttleByte, btnLo, btnHi] = ev.bytes;
  if (jog === undefined) return null;
  const shuttle = shuttleByte > 127 ? shuttleByte - 256 : shuttleByte;
  const buttons = ((btnHi ?? 0) << 8) | (btnLo ?? 0);
  return { jog, shuttle, buttons };
}
