import { DataStream } from "mp4box";

/**
 * Serialize an mp4box sample-entry config box (avcC / hvcC) into the WebCodecs
 * `description` bytes (the raw decoder configuration record — the box payload
 * with its 8-byte header removed).
 *
 * mp4box's `Box.write()` drives a real `DataStream` (`getPosition()`,
 * `writeUint32()`, `writeString()`, `writeUint8Array()`, …). Passing a
 * hand-rolled `{ buffer, pos }` object throws
 * "stream.getPosition is not a function"; a `DataStream` (default endianness
 * big-endian, as MP4 boxes use) provides those methods and grows as written.
 */
export function serializeBoxToDescription(
  box: { write: (stream: DataStream) => void },
): Uint8Array {
  const stream = new DataStream();
  box.write(stream);
  return new Uint8Array(stream.buffer as ArrayBuffer, 8);
}
