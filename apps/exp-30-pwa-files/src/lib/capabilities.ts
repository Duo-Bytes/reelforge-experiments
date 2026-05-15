export type Capability = {
  name: string;
  supported: boolean;
  detail?: string;
};

export function detectCapabilities(): Capability[] {
  if (typeof window === "undefined") return [];
  const caps: Capability[] = [];

  caps.push({
    name: "LaunchQueue",
    supported: "launchQueue" in window,
    detail: "window.launchQueue.setConsumer for file-handler launches",
  });

  // File Handling API surface — we can only detect indirectly. The presence
  // of launchQueue is the strongest signal in Chromium-desktop.
  caps.push({
    name: "File Handling (manifest)",
    supported: "launchQueue" in window,
    detail: "manifest.file_handlers + LaunchParams.files",
  });

  caps.push({
    name: "Share Target",
    supported: "serviceWorker" in navigator,
    detail: "POST /share consumed by service worker / app",
  });

  caps.push({
    name: "navigator.share",
    supported: typeof navigator !== "undefined" && "share" in navigator,
    detail: "outbound share sheet",
  });

  caps.push({
    name: "navigator.canShare(files)",
    supported:
      typeof navigator !== "undefined" &&
      typeof (navigator as Navigator & { canShare?: (data: ShareData) => boolean }).canShare ===
        "function",
    detail: "file-level share support detection",
  });

  caps.push({
    name: "Service Worker",
    supported: "serviceWorker" in navigator,
    detail: "required for installability + share_target",
  });

  caps.push({
    name: "Standalone display mode",
    supported:
      typeof window !== "undefined" &&
      window.matchMedia?.("(display-mode: standalone)").matches === true,
    detail: "running as installed PWA",
  });

  caps.push({
    name: "beforeinstallprompt",
    supported: "onbeforeinstallprompt" in window,
    detail: "captured install prompt",
  });

  return caps;
}

// Minimal type for the BeforeInstallPromptEvent — Chromium-specific.
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};
