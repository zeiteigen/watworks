import { endianness } from "node:os";

const littleEndian = endianness() === "LE";
const MAX_REQUEST_BYTES = 1024;

/** Chrome native messaging uses a native-endian uint32 byte length, then UTF-8 JSON. */
export function encodeMessage(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const message = new Uint8Array(4 + body.length);
  new DataView(message.buffer).setUint32(0, body.length, littleEndian);
  message.set(body, 4);
  return message;
}

export async function readMessage(chunks: AsyncIterable<Uint8Array>): Promise<unknown> {
  let buffer = new Uint8Array(0);
  for await (const chunk of chunks) {
    // Never accumulate an unbounded request, including before the header arrives.
    if (buffer.length + chunk.length > MAX_REQUEST_BYTES + 4) throw new Error("Native message is too large");
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer); next.set(chunk, buffer.length); buffer = next;
    if (buffer.length < 4) continue;
    const length = new DataView(buffer.buffer).getUint32(0, littleEndian);
    if (!length || length > MAX_REQUEST_BYTES) throw new Error("Invalid native message length");
    if (buffer.length >= length + 4) return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4, length + 4)));
  }
  throw new Error("Incomplete native message");
}
