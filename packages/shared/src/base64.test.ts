import { expect, test } from "bun:test";
import { isBase64 } from "./base64.js";

test("accepts valid base64 at any size and rejects malformed input", () => {
  expect(isBase64(btoa("%PDF-1.7"))).toBe(true);
  expect(isBase64("")).toBe(true);
  // Past the size where the former grouped regex overflowed V8's regexp stack.
  expect(isBase64("A".repeat(16_000_000))).toBe(true);
  for (const bad of ["abc", "ab=c", "a===", "ab c", "abc$", "A".repeat(16_000_001)]) expect(isBase64(bad)).toBe(false);
});
