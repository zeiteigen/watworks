import { describe, expect, test } from "bun:test";
import { NativeMessageDecoder, encodeNativeMessage } from "./native-messaging.js";

describe("Chromium native messaging framing", () => {
  test("uses a little-endian length and handles split frames", () => {
    const message = {
      type: "waterlooworks-session" as const,
      cookies: [
        {
          name: "WW_SESSION",
          value: "fake-cookie-value",
          domain: "waterlooworks.uwaterloo.ca",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      obtainedAt: "2026-09-16T00:00:00.000Z",
    };
    const frame = encodeNativeMessage(message);
    const declaredLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
    expect(declaredLength).toBe(frame.length - 4);

    const decoder = new NativeMessageDecoder();
    expect(decoder.push(frame.slice(0, 2))).toEqual([]);
    expect(decoder.push(frame.slice(2, 7))).toEqual([]);
    expect(decoder.push(frame.slice(7))).toEqual([message]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  test("rejects frames above the safety limit", () => {
    const frame = new Uint8Array(4);
    new DataView(frame.buffer).setUint32(0, 9 * 1024 * 1024, true);
    expect(() => new NativeMessageDecoder().push(frame)).toThrow(/exceeds/);
  });
});
