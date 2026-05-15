export const LOCK_NAME = "reelforge-project";
export const CHANNEL_NAME = "reelforge-project";
export const OPFS_FILE = "project.json";

export type MainToWorker =
  | { kind: "write"; text: string }
  | { kind: "read" }
  | { kind: "close" };

export type WorkerToMain =
  | { kind: "ready" }
  | { kind: "wrote"; at: number; bytes: number }
  | { kind: "read"; text: string; at: number }
  | { kind: "error"; message: string };

export type BroadcastMessage =
  | { kind: "updated"; from: string; at: number }
  | { kind: "hello"; from: string; role: "primary" | "reader"; at: number };
