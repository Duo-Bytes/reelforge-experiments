# exp-30 · PWA Install + File Handlers + Web Share Target

## Purpose

Wire up the four OS-integration surfaces a serious browser editor
needs: install-to-OS, double-click-to-open via `file_handlers`,
"Share to ReelForge" via `share_target`, and outbound `navigator.share`
of an exported clip.

## Running

```
pnpm --filter exp-30-pwa-files dev
```

Open `http://localhost:3000` in Chrome desktop. Other browsers will
load the page but most capabilities will be reported as unsupported.

To exercise `file_handlers` and `share_target` you must actually
install the app: click the install button in the page (or use the
URL bar install icon).

## What to look for in the UI

- **Capability matrix**: each row shows supported / unsupported for
  `LaunchQueue`, `File Handling`, `Share Target`, `navigator.share`,
  `Standalone display mode`, `Service Worker`.
- **Install button**: appears once Chrome fires `beforeinstallprompt`;
  disappears once `appinstalled` fires.
- **Launched files panel**: when the PWA is launched via "Open with",
  the consumer reads each `FileSystemHandle` from `launchQueue` and
  renders name, size, type, and last-modified.
- **Share buttons**: tries `navigator.share` with a synthesized text
  file; reports `canShare` results.

## Success bar

1. Page loads with all rows in the matrix correctly labelled.
2. Install button works, the relaunched window has
   `display-mode: standalone`, and the install button disappears.
3. After install, double-clicking an `.mp4` in Finder/Explorer (on
   Chromium desktop) opens the PWA and the file appears in the
   Launched files panel within 200 ms.
4. `navigator.share` test surfaces a real share sheet on platforms
   that support file sharing (Android, recent macOS Chrome).

## Foot-guns covered

- File Handling is Chromium-desktop only; UI gates on detection.
- `launchQueue.setConsumer` must register synchronously — no
  `await` before it in `useEffect`.
- `beforeinstallprompt` fires once; the event is captured and held.
- Service Worker is registered but caches nothing (this experiment
  is install + handlers, not offline).
