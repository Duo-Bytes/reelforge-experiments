# Exp-36 · Hardware Control Surfaces (WebMIDI + WebHID)

## Goal

Connect a Behringer X-Touch Mini via WebMIDI and bind its 8 rotary
encoders to lift / gamma / gain RGB. Connect a Contour ShuttlePro v2
via WebHID and bind the jog-wheel to ±1-frame step and the shuttle ring
to variable-rate scrub. Demonstrate latency under 8 ms from device
input to UI state update.

## App Location

`apps/exp-36-control-surfaces/`

## Why This Matters — Competitive Edge

No cloud editor supports hardware control surfaces. They'd need a native
install, which defeats their entire pitch. ReelForge is the only browser
editor that can drive a Loupedeck Live, X-Touch, ShuttlePro, or even a
generic Xbox controller as a shuttle — with **zero install** because
WebMIDI and WebHID are first-class browser APIs.

Pro colorists and podcast editors will switch tools for this alone. See
[`research-competitive-edge.md`](./research-competitive-edge.md) §36.

## Key APIs

| API | Where used |
|---|---|
| `navigator.requestMIDIAccess({ sysex: false })` | MIDI device discovery |
| `MIDIInput.onmidimessage` | Per-event control change handler |
| `navigator.hid.requestDevice({ filters: [...] })` | HID picker |
| `HIDDevice.oninputreport` | Raw input reports |
| Zustand `set` (exp-09) | State update from device |
| WGSL color uniform bind group (exp-04) | Pipeline that consumes lift/gamma/gain |

## Device matrix

| Device | Class | Notes |
|---|---|---|
| Behringer X-Touch Mini | MIDI | 8 encoders + 16 buttons, MC mode preferred |
| Korg nanoKONTROL2 | MIDI | 8 faders + 8 knobs, MIDI CC default |
| Loupedeck Live | MIDI (via app) | Or HID under flag — defer SysEx until v2 |
| Contour ShuttlePro v2 | HID | Vendor 0x0b33, product 0x0030 |
| Contour ShuttleXpress | HID | Vendor 0x0b33, product 0x0020 |
| Xbox / DualSense controller | HID (gamepad) | Optional thumb-stick as shuttle |
| Stream Deck (MIDI mode) | MIDI | Treat like X-Touch buttons |

## Bindings v1

- **X-Touch encoder 1–3** → lift R, G, B (each ±0.5 range)
- **X-Touch encoder 4–6** → gamma R, G, B (each 0.5–1.5)
- **X-Touch encoder 7–9** → gain R, G, B (each 0–2)
- **X-Touch button row** → A/B compare, reset all, save grade
- **ShuttlePro jog** → ±1 frame per detent
- **ShuttlePro shuttle ring** → variable scrub rate (–7 .. +7)
- **ShuttlePro F1..F15** → mark in/out, ripple cut, split, etc.

## Success Criteria

1. From device event → Zustand state update in **< 8 ms** (measured via
   `performance.now()` deltas).
2. Color uniforms in the WGSL pipeline reflect the change next frame
   (no animation, no debounce — pro tools feel mechanical).
3. Disconnecting and reconnecting the device live: bindings restore on
   reconnect via persisted device-id.
4. Permission UX: a single `requestMIDIAccess` and a per-device
   `hid.requestDevice` prompt only; never two MIDI prompts.
5. Multi-device: X-Touch + ShuttlePro plugged simultaneously both work
   without event-loop contention.

## Foot-guns

- WebMIDI requires a **secure context** and a permission prompt;
  localhost works. SysEx requires a **second** prompt and is *not* enabled
  by default — only request it if a controller-specific protocol (e.g.
  Loupedeck) demands it.
- Multiple MIDI ports per controller is common (X-Touch advertises 2);
  match by `MIDIInput.name`, not by index.
- WebHID needs an explicit user click to call `hid.requestDevice` — you
  cannot enumerate at page load. Persist `HIDDevice.productId/vendorId`
  in IndexedDB and re-call `hid.getDevices()` on next load to skip the
  prompt.
- HID input reports are binary; per-device parsers live in
  `src/lib/hid/<vendor>-<product>.ts`.
- The Loupedeck Live MIDI mode is undocumented; until SysEx is on,
  defer it.

## Demo

- Permissions wizard guides the user through MIDI + HID approval.
- A live "knob mirror" panel echoes every MIDI CC and HID report so the
  user can verify the wiring.
- A test image (the SMPTE bars) sits in the compositor; turning the
  X-Touch encoders moves the lift/gamma/gain visibly in real time, with
  scopes (exp-35) updating in lockstep.
- ShuttlePro scrubs the timeline at variable rate.
