import { describe, expect, test } from "bun:test";
import { ProtocolChangedError } from "../src/errors.js";
import { BrowserExtensionSessionProvider } from "../src/session.js";

function response(value: string, url: string): Response {
  return {
    status: 200,
    ok: true,
    url,
    json: async () => JSON.parse(value),
    text: async () => value,
  } as Response;
}

describe("BrowserExtensionSessionProvider", () => {
  test("retrieves only the bridge session endpoint and parses WaterlooWorks cookies", async () => {
    const requested: string[] = [];
    const provider = new BrowserExtensionSessionProvider({
      baseUrl: "http://127.0.0.1:45555",
      fetchImpl: async (input) => {
        requested.push(String(input));
        return response(
          JSON.stringify({
            cookies: [
              {
                name: "WW_SESSION",
                value: "redacted-test-value",
                domain: ".WATERLOOWORKS.UWATERLOO.CA",
                path: "/",
                secure: true,
                httpOnly: true,
              },
            ],
            obtainedAt: "2026-09-16T00:00:00.000Z",
          }),
          String(input),
        );
      },
    });

    const session = await provider.getSession({ forceRefresh: true });
    expect(requested).toEqual(["http://127.0.0.1:45555/session?refresh=1"]);
    expect(session.cookies[0]?.name).toBe("WW_SESSION");
  });

  test("fails with ProtocolChangedError for malformed bridge JSON", async () => {
    const provider = new BrowserExtensionSessionProvider({
      baseUrl: "http://localhost:45555",
      fetchImpl: async (input) => response("not-json", String(input)),
    });

    await expect(provider.getSession()).rejects.toBeInstanceOf(ProtocolChangedError);
  });

  test("parses bridge health metadata", async () => {
    const provider = new BrowserExtensionSessionProvider({
      baseUrl: "http://[::1]:45555",
      fetchImpl: async (input) =>
        response(
          JSON.stringify({ bridgeConnected: true, sessionAvailable: false, cookieCount: 0 }),
          String(input),
        ),
    });

    await expect(provider.health()).resolves.toEqual({
      bridgeConnected: true,
      sessionAvailable: false,
      cookieCount: 0,
    });
  });
});
