import type { BridgeResponse, BridgeRequest } from "../../shared/src/protocol.js";
import { isBridgeResponse } from "../../shared/src/protocol.js";

export type NativeMessage = BridgeRequest | BridgeResponse;

const NATIVE_MESSAGE_HEADER_BYTES = 4;
const MAX_NATIVE_MESSAGE_BYTES = 8 * 1024 * 1024;

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

export function encodeNativeMessage(message: NativeMessage): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  if (payload.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`Native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
  }

  const frame = new Uint8Array(NATIVE_MESSAGE_HEADER_BYTES + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, NATIVE_MESSAGE_HEADER_BYTES);
  return frame;
}

export class NativeMessageDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  push(chunk: Uint8Array<ArrayBufferLike>): BridgeResponse[] {
    this.buffer = concatBytes(this.buffer, chunk);
    const messages: BridgeResponse[] = [];

    while (this.buffer.length >= NATIVE_MESSAGE_HEADER_BYTES) {
      const payloadLength = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength,
      ).getUint32(0, true);

      if (payloadLength > MAX_NATIVE_MESSAGE_BYTES) {
        throw new Error(`Native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
      }

      const frameLength = NATIVE_MESSAGE_HEADER_BYTES + payloadLength;
      if (this.buffer.length < frameLength) break;

      const payloadBytes = this.buffer.slice(NATIVE_MESSAGE_HEADER_BYTES, frameLength);
      this.buffer = this.buffer.slice(frameLength);
      const payload = new TextDecoder().decode(payloadBytes);
      const parsed: unknown = JSON.parse(payload);
      if (!isBridgeResponse(parsed)) {
        throw new Error("Received an invalid message from the browser extension");
      }
      messages.push(parsed);
    }

    return messages;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }
}

export async function writeNativeMessage(message: NativeMessage): Promise<void> {
  const frame = encodeNativeMessage(message);
  await Bun.stdout.write(frame);
}

export async function runNativeMessageLoop(
  onMessage: (message: BridgeResponse) => Promise<void> | void,
): Promise<void> {
  const decoder = new NativeMessageDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    const messages = decoder.push(chunk);
    for (const message of messages) await onMessage(message);
  }
}
