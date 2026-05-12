export type Transfer = "srgb" | "bt709" | "pq" | "hlg" | "linear";
export type Primaries = "bt709" | "p3" | "bt2020";
export type MatrixCoeffs = "rgb" | "bt709" | "bt2020-ncl";

export type SourceColor = {
  primaries: Primaries;
  transfer: Transfer;
  matrix: MatrixCoeffs;
  fullRange: boolean;
};

export type TargetColor =
  | { kind: "srgb-sdr" }
  | { kind: "p3-sdr" }
  | { kind: "hdr10-pq" };

export type ToneMap = "none" | "reinhard" | "hable";

export type LayerInfo = {
  label: string;
  width: number;
  height: number;
  source: SourceColor;
  detected: string; // raw VideoColorSpace fields or createImageBitmap result
};
