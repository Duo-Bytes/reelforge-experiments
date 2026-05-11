export type ClipId = string;
export type TrackId = string;

export interface Clip {
  id: ClipId;
  trackId: TrackId;
  startUs: number;
  durationUs: number;
  sourceFileId: string;
  label: string;
  color: string;
}

export interface Track {
  id: TrackId;
  label: string;
  type: "video" | "audio";
  clipIds: ClipId[];
}

export const PALETTE = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#6366f1",
  "#a855f7",
  "#ec4899",
];
