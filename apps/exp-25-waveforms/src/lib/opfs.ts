/**
 * OPFS helpers for peak/thumbnail caching.
 */

const WAVEFORM_DIR = "waveforms";

export async function getWaveformDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(WAVEFORM_DIR, { create: true });
}

export async function hasPeakFile(hash: string): Promise<boolean> {
  const dir = await getWaveformDir();
  try {
    await dir.getFileHandle(`${hash}.peaks`);
    return true;
  } catch {
    return false;
  }
}

export async function readPeakFile(hash: string): Promise<ArrayBuffer | null> {
  const dir = await getWaveformDir();
  try {
    const fh = await dir.getFileHandle(`${hash}.peaks`);
    const file = await fh.getFile();
    return file.arrayBuffer();
  } catch {
    return null;
  }
}

export async function writePeakFile(
  hash: string,
  data: ArrayBuffer,
): Promise<number> {
  const dir = await getWaveformDir();
  const fh = await dir.getFileHandle(`${hash}.peaks`, { create: true });
  const writable = await fh.createWritable();
  await writable.write(data);
  await writable.close();
  return data.byteLength;
}

export async function hashFloat32(
  channel: Float32Array,
  duration: number,
): Promise<string> {
  // Cheap content hash: SHA-256 over a head + tail slice plus the duration
  // (avoids hashing 100 MB of samples on every load).
  const head = channel.subarray(0, Math.min(channel.length, 4096));
  const tail = channel.subarray(Math.max(0, channel.length - 4096));
  const combined = new Uint8Array(head.byteLength + tail.byteLength + 8);
  combined.set(new Uint8Array(head.buffer, head.byteOffset, head.byteLength), 0);
  combined.set(
    new Uint8Array(tail.buffer, tail.byteOffset, tail.byteLength),
    head.byteLength,
  );
  new DataView(combined.buffer).setFloat64(
    head.byteLength + tail.byteLength,
    duration,
    true,
  );
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
