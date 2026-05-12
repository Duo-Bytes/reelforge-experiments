// Codec probe matrix.
//
// Each row tests one `{codec, width, height, bitDepth, hardwareAcceleration}`
// combination via VideoDecoder.isConfigSupported + VideoEncoder.isConfigSupported.
// Output: the boolean + the config the UA echoed back (sometimes the UA
// substitutes a different codec string, e.g. avc1.42E01E -> avc1.42E01F).

export type HwPref = "prefer-hardware" | "prefer-software" | "no-preference";

export type CodecRow = {
  family: "H.264" | "HEVC" | "VP9" | "AV1" | "VVC";
  // Common codec strings spanning baseline → high profiles + bit depths.
  codec: string;
  bitDepth: 8 | 10 | 12;
  notes?: string;
};

export const CODECS: CodecRow[] = [
  { family: "H.264", codec: "avc1.42E01E", bitDepth: 8, notes: "Baseline 3.0" },
  { family: "H.264", codec: "avc1.4D401E", bitDepth: 8, notes: "Main 3.0" },
  { family: "H.264", codec: "avc1.640828", bitDepth: 8, notes: "High 4.0" },
  { family: "H.264", codec: "avc1.640033", bitDepth: 8, notes: "High 5.1 (4K)" },
  { family: "HEVC", codec: "hev1.1.6.L93.B0", bitDepth: 8, notes: "Main 3.1" },
  { family: "HEVC", codec: "hev1.1.6.L120.B0", bitDepth: 8, notes: "Main 4.0" },
  { family: "HEVC", codec: "hev1.1.6.L150.B0", bitDepth: 8, notes: "Main 5.0 (4K)" },
  { family: "HEVC", codec: "hev1.2.4.L150.B0", bitDepth: 10, notes: "Main10 5.0 (HDR10 4K)" },
  { family: "VP9", codec: "vp09.00.10.08", bitDepth: 8, notes: "Profile 0 Level 1" },
  { family: "VP9", codec: "vp09.00.51.08", bitDepth: 8, notes: "Profile 0 Level 5.1 (4K)" },
  { family: "VP9", codec: "vp09.02.51.10", bitDepth: 10, notes: "Profile 2 10-bit 4K" },
  { family: "AV1", codec: "av01.0.04M.08", bitDepth: 8, notes: "Main 4 8-bit" },
  { family: "AV1", codec: "av01.0.12M.08", bitDepth: 8, notes: "Main 5.1 8-bit (4K)" },
  { family: "AV1", codec: "av01.0.12M.10", bitDepth: 10, notes: "Main 5.1 10-bit (HDR 4K)" },
  { family: "VVC", codec: "vvc1.1.L51.CYA.O1+1", bitDepth: 8, notes: "VVC Main 5.1 (H.266)" },
];

export type Resolution = { width: number; height: number; label: string };
export const RESOLUTIONS: Resolution[] = [
  { width: 1280, height: 720, label: "720p" },
  { width: 1920, height: 1080, label: "1080p" },
  { width: 3840, height: 2160, label: "4K UHD" },
];

export const HW_PREFS: HwPref[] = [
  "prefer-hardware",
  "prefer-software",
  "no-preference",
];

export type ProbeResult = {
  codec: string;
  family: CodecRow["family"];
  bitDepth: number;
  width: number;
  height: number;
  hardwareAcceleration: HwPref;
  // Decoder side
  decoderSupported: boolean | "error";
  decoderConfig?: unknown;
  decoderError?: string;
  // Encoder side
  encoderSupported: boolean | "error";
  encoderConfig?: unknown;
  encoderError?: string;
};

export async function probeRow(
  codec: CodecRow,
  res: Resolution,
  hw: HwPref,
): Promise<ProbeResult> {
  const base = {
    codec: codec.codec,
    codedWidth: res.width,
    codedHeight: res.height,
    hardwareAcceleration: hw,
  };

  let decoderSupported: boolean | "error" = false;
  let decoderConfig: unknown;
  let decoderError: string | undefined;
  try {
    const s = await VideoDecoder.isConfigSupported(base);
    decoderSupported = !!s.supported;
    decoderConfig = s.config;
  } catch (err) {
    decoderSupported = "error";
    decoderError = err instanceof Error ? err.message : String(err);
  }

  let encoderSupported: boolean | "error" = false;
  let encoderConfig: unknown;
  let encoderError: string | undefined;
  try {
    const s = await VideoEncoder.isConfigSupported({
      ...base,
      width: res.width,
      height: res.height,
      bitrate: bitrateFor(res),
      framerate: 30,
    } as VideoEncoderConfig);
    encoderSupported = !!s.supported;
    encoderConfig = s.config;
  } catch (err) {
    encoderSupported = "error";
    encoderError = err instanceof Error ? err.message : String(err);
  }

  return {
    codec: codec.codec,
    family: codec.family,
    bitDepth: codec.bitDepth,
    width: res.width,
    height: res.height,
    hardwareAcceleration: hw,
    decoderSupported,
    decoderConfig,
    decoderError,
    encoderSupported,
    encoderConfig,
    encoderError,
  };
}

function bitrateFor(r: Resolution): number {
  if (r.height >= 2160) return 50_000_000;
  if (r.height >= 1080) return 10_000_000;
  return 4_000_000;
}

// Branching profile derived from probe results — what the editor would
// enable / disable / fallback for the user.
export type CapabilityProfile = {
  canIngestH264: boolean;
  canIngestHEVC: boolean;
  canIngestHEVCHDR: boolean;
  canIngestVP9: boolean;
  canIngestAV1: boolean;
  canEncodeH264HW: boolean;
  canEncodeHEVCHW: boolean;
  canEncodeAV1HW: boolean;
  canExport4K: boolean;
  proxyRequiredForHEVC: boolean;
  recommendedProxyCodec: "H.264" | "HEVC" | "AV1";
};

export function computeProfile(rows: ProbeResult[]): CapabilityProfile {
  const has = (
    family: CodecRow["family"],
    bd: number,
    side: "decoderSupported" | "encoderSupported",
    hw?: HwPref,
    resAtLeast?: number,
  ): boolean =>
    rows.some(
      (r) =>
        r.family === family &&
        r.bitDepth === bd &&
        r[side] === true &&
        (!hw || r.hardwareAcceleration === hw) &&
        (resAtLeast === undefined || r.height >= resAtLeast),
    );

  const canIngestH264 = has("H.264", 8, "decoderSupported");
  const canIngestHEVC = has("HEVC", 8, "decoderSupported");
  const canIngestHEVCHDR = has("HEVC", 10, "decoderSupported");
  const canIngestVP9 = has("VP9", 8, "decoderSupported");
  const canIngestAV1 = has("AV1", 8, "decoderSupported");
  const canEncodeH264HW = has(
    "H.264",
    8,
    "encoderSupported",
    "prefer-hardware",
  );
  const canEncodeHEVCHW = has(
    "HEVC",
    8,
    "encoderSupported",
    "prefer-hardware",
  );
  const canEncodeAV1HW = has(
    "AV1",
    8,
    "encoderSupported",
    "prefer-hardware",
  );
  const canExport4K =
    has("H.264", 8, "encoderSupported", undefined, 2160) ||
    has("HEVC", 8, "encoderSupported", undefined, 2160) ||
    has("AV1", 8, "encoderSupported", undefined, 2160);
  const proxyRequiredForHEVC = canIngestHEVC && !canEncodeHEVCHW;
  // Pick a proxy codec by preference: AV1 > HEVC > H.264 (smaller files
  // when supported). H.264 is the safe fallback.
  let recommendedProxyCodec: CapabilityProfile["recommendedProxyCodec"] =
    "H.264";
  if (canEncodeAV1HW) recommendedProxyCodec = "AV1";
  else if (canEncodeHEVCHW) recommendedProxyCodec = "HEVC";

  return {
    canIngestH264,
    canIngestHEVC,
    canIngestHEVCHDR,
    canIngestVP9,
    canIngestAV1,
    canEncodeH264HW,
    canEncodeHEVCHW,
    canEncodeAV1HW,
    canExport4K,
    proxyRequiredForHEVC,
    recommendedProxyCodec,
  };
}

export async function probeAdapterInfo(): Promise<{
  vendor: string;
  architecture: string;
  device: string;
  description: string;
} | null> {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  // info is the spec'd property; older builds expose requestAdapterInfo()
  const a = adapter as GPUAdapter & {
    info?: {
      vendor: string;
      architecture: string;
      device: string;
      description: string;
    };
    requestAdapterInfo?: () => Promise<{
      vendor: string;
      architecture: string;
      device: string;
      description: string;
    }>;
  };
  if (a.info) return a.info;
  if (a.requestAdapterInfo) return await a.requestAdapterInfo();
  return { vendor: "", architecture: "", device: "", description: "" };
}
