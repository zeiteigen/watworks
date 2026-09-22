import { describe, expect, test } from "bun:test";
import { isBridgeResponse } from "./protocol.js";

describe("shared bridge protocol guards", () => {
  test("accepts a well-formed WaterlooWorks session response", () => {
    expect(
      isBridgeResponse({
        type: "waterlooworks-session",
        cookies: [
          {
            name: "WW_SESSION",
            value: "redacted-test-value",
            domain: "waterlooworks.uwaterloo.ca",
            path: "/",
            secure: true,
            httpOnly: true,
          },
        ],
        obtainedAt: "2026-09-16T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  test("rejects malformed session and error responses", () => {
    expect(isBridgeResponse({ type: "waterlooworks-session", cookies: [], obtainedAt: 123 })).toBe(false);
    expect(isBridgeResponse({ type: "waterlooworks-session", cookies: [{ name: "WW_SESSION" }], obtainedAt: "now" })).toBe(
      false,
    );
    expect(isBridgeResponse({ type: "error", message: 123 })).toBe(false);
  });
});
