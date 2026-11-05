import { describe, expect, test } from "bun:test";
import { isWaterlooWorksSession } from "./protocol.js";

describe("shared bridge protocol guards", () => {
  test("accepts a well-formed WaterlooWorks session", () => {
    expect(
      isWaterlooWorksSession({
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

  test("rejects malformed sessions", () => {
    expect(isWaterlooWorksSession({ cookies: [], obtainedAt: 123 })).toBe(false);
    expect(isWaterlooWorksSession({ cookies: [{ name: "WW_SESSION" }], obtainedAt: "now" })).toBe(false);
  });
});
