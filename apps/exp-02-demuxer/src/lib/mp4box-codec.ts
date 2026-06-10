import { DataStream } from "mp4box";

/**
 * Serialize an mp4box sample-entry config box (avcC / hvcC) into the
 * WebCodecs `description` bytes (the raw AVC/HEVC decoder configuration
 * record, i.e. the box payload with its 8-byte header removed).
 *
 * mp4box's `Box.write()` drives a real `DataStream` — it calls
 * `getPosition()`, `writeUint32()`, `writeString()`, `writeUint8Array()`, etc.
 * Passing a hand-rolled `{ buffer, pos }` object throws
 * "stream.getPosition is not a function". A `DataStream` (default endianness
 * is big-endian, which is what MP4 boxes use) provides those methods and grows
 * its buffer as the box writes into it.
 */
export function serializeBoxToDescription(
  box: { write: (stream: DataStream) => void },
): Uint8Array {
  const stream = new DataStream();
  box.write(stream);
  // The box writes a 4-byte size + 4-byte fourcc header ahead of the config
  // record; WebCodecs wants only the record, so skip the first 8 bytes.
  return new Uint8Array(stream.buffer as ArrayBuffer, 8);
}
