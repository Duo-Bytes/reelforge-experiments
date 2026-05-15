/**
 * OPFS session helpers for exp-29.
 *
 * Layout:
 *   /captures/{id}/session.json    metadata + status
 *                  /chunks.json     append-only chunk index
 *                  /video.h264      raw bitstream (NOT muxed)
 */

const CAPTURES_DIR = "captures";

export type SessionMeta = {
  id: string;
  startedAt: number;
  status: "recording" | "complete" | "aborted";
  codec: string;
  width: number;
  height: number;
  source: "screen" | "camera";
};

export type ChunkIndexEntry = {
  ts: number; // microseconds (from EncodedVideoChunk.timestamp)
  dur: number; // microseconds
  kf: boolean;
  byteOffset: number;
  byteLength: number;
};

export type SessionHandles = {
  meta: SessionMeta;
  dir: FileSystemDirectoryHandle;
  videoWritable: FileSystemWritableFileStream;
  chunks: ChunkIndexEntry[];
  byteOffset: number;
};

async function getCapturesDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(CAPTURES_DIR, { create: true });
}

export async function openSession(meta: SessionMeta): Promise<SessionHandles> {
  const captures = await getCapturesDir();
  const dir = await captures.getDirectoryHandle(meta.id, { create: true });
  await writeJson(dir, "session.json", meta);
  await writeJson(dir, "chunks.json", []);
  const video = await dir.getFileHandle("video.h264", { create: true });
  const writable = await video.createWritable();
  return {
    meta,
    dir,
    videoWritable: writable,
    chunks: [],
    byteOffset: 0,
  };
}

export async function appendChunk(
  session: SessionHandles,
  data: ArrayBufferLike,
  ts: number,
  duration: number,
  kf: boolean,
): Promise<void> {
  const view = new Uint8Array(data);
  await session.videoWritable.write({
    type: "write",
    position: session.byteOffset,
    data: view,
  });
  const entry: ChunkIndexEntry = {
    ts,
    dur: duration,
    kf,
    byteOffset: session.byteOffset,
    byteLength: view.byteLength,
  };
  session.chunks.push(entry);
  session.byteOffset += view.byteLength;
  // Persist chunks.json after every ~30 entries; flush sooner for keyframes.
  if (kf || session.chunks.length % 30 === 0) {
    await writeJson(session.dir, "chunks.json", session.chunks);
  }
}

export async function closeSession(
  session: SessionHandles,
  status: "complete" | "aborted",
): Promise<void> {
  try {
    await writeJson(session.dir, "chunks.json", session.chunks);
    await writeJson(session.dir, "session.json", {
      ...session.meta,
      status,
    });
  } finally {
    try {
      await session.videoWritable.close();
    } catch {
      // ignore — may already be closed
    }
  }
}

export async function listSessions(): Promise<SessionMeta[]> {
  const captures = await getCapturesDir();
  const out: SessionMeta[] = [];
  for await (const [name, handle] of (captures as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >)) {
    if (handle.kind !== "directory") continue;
    try {
      const dir = handle as FileSystemDirectoryHandle;
      const fh = await dir.getFileHandle("session.json");
      const file = await fh.getFile();
      const text = await file.text();
      const meta = JSON.parse(text) as SessionMeta;
      out.push(meta);
    } catch {
      // skip directories without a session.json
    }
    void name;
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export async function deleteSession(id: string): Promise<void> {
  const captures = await getCapturesDir();
  await captures.removeEntry(id, { recursive: true });
}

async function writeJson(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: unknown,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(new Blob([JSON.stringify(data)]));
  await writable.close();
}
