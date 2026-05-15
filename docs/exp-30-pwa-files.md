# Exp-30 · PWA Install + File Handlers + Web Share Target

## Goal

Install the app as a PWA, register OS-level file associations for
`.mp4`, `.mov`, and `.reelproj`, receive shared files via Web Share
Target, and read the launched / shared files from `window.launchQueue`.
Demonstrate `navigator.share` for outbound sharing of an exported clip.

## App Location

`apps/exp-30-pwa-files/`

## Why This Matters in the Full NLE

First-class OS integration is the difference between a "demo in a tab"
and a serious editor. Double-click a `.mp4` in Finder/Explorer and the
installed PWA should open with that file already loaded; the same
applies to a custom `.reelproj` project file. Web Share Target lets a
mobile user "Share to ReelForge" from the photos app. Both rely on the
PWA being installed and on `launchQueue` consumption happening before
any other navigation logic runs.

## Key APIs

| API | Where used |
|---|---|
| `manifest.file_handlers` | Register `.mp4` / `.mov` / `.reelproj` |
| `manifest.share_target` | POST endpoint for shared media |
| `window.launchQueue.setConsumer(params)` | Read `params.files` on launch |
| `beforeinstallprompt` | Capture and trigger install UI |
| `navigator.share({ files, title })` | Outbound share |
| `navigator.serviceWorker.register('/sw.js')` | Optional install prereq |

## Implementation Notes / Approach

- A static manifest is served at `public/manifest.json` and linked via
  `metadata.manifest` in `layout.tsx`. It declares `display:
  "standalone"`, `start_url: "/"`, two `file_handlers` entries
  (`accept: { "video/mp4": [".mp4", ".mov"], "application/reelproj+json":
  [".reelproj"] }`) and a `share_target` POSTing to `/share` with
  `enctype: "multipart/form-data"`.
- A minimal `public/sw.js` is registered on mount; it calls
  `self.skipWaiting()` and caches nothing (this experiment is about
  install + handlers, not offline). PWA installability requires a SW
  in Chromium even today.
- The page captures `beforeinstallprompt` into state and exposes an
  Install button which calls `prompt()` and reports the user choice.
- On mount, if `'launchQueue' in window`, a consumer is registered
  that reads `params.files` (`FileSystemHandle[]`), resolves each to a
  `File`, and renders name / size / type / last-modified.
- `navigator.share` and `navigator.canShare` capability is detected;
  a button shares a small synthesized text file to test the surface.
- Capability matrix at the top of the page: `Installable`, `Installed`
  (`display-mode: standalone`), `LaunchQueue`, `FileHandling`,
  `ShareTarget`, `Share` — each shown supported / unsupported.

## Success Criteria

1. After install, double-clicking an `.mp4` (Chrome desktop) launches
   the PWA and the file appears in the "Launched files" panel within
   200 ms.
2. The install button works on a fresh load and disappears once
   installed; the standalone-mode badge appears after relaunch.
3. `navigator.share` with a `File` succeeds on Android; on desktop it
   reports `canShare: false` for files and the UI degrades.
4. Reloading inside the installed window keeps OS integration intact.

## Foot-guns

- File Handling API is Chromium-desktop only. On Firefox/Safari and on
  Android Chrome the manifest entry is silently ignored — gate UI on
  feature detection, not on a flag.
- `launchQueue.setConsumer` must be registered before the first
  microtask after navigation; if you `await` something first you can
  miss the launch params. Register synchronously in `useEffect`.
- Web Share Target only works after install; testing it without
  installing the app first will appear broken.
- `beforeinstallprompt` fires once per page; you cannot re-trigger it
  on demand. Cache the event in state.
- A Service Worker is currently still required for installability in
  Chromium even though the spec has been moving away from that
  requirement. Keep `public/sw.js` even if it does nothing useful.
- COOP/COEP headers in `next.config.ts` interact with Share Target
  POSTs from third-party origins — the share endpoint must be on the
  same origin and the request is opaque-redirect compatible.
