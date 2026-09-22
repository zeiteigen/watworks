import { describe, expect, test } from "bun:test";
import { BridgeState, createBridgeServer } from "../../bridge/src/index.js";
import { WaterlooWorksClient } from "../src/client.js";
import { BrowserExtensionSessionProvider } from "../src/session.js";

const page = await Bun.file(new URL("./fixtures/jobs-page.html", import.meta.url)).text();

describe("bridge, session provider, and client integration", () => {
  test("reports an authenticated bootstrapped health state over loopback", async () => {
    const state = new BridgeState();
    state.setSession({
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
    });
    const bridge = createBridgeServer(state, 0);

    try {
      const provider = new BrowserExtensionSessionProvider({
        baseUrl: `http://127.0.0.1:${bridge.port}`,
      });
      const client = new WaterlooWorksClient(provider, {
        fetchImpl: async (input, init) =>
          ({
            status: 200,
            ok: true,
            url: String(input),
            text: async () => (!init?.method || init.method === "GET" ? page : "{}"),
          }) as Response,
      });

      await expect(client.health()).resolves.toEqual({
        authenticated: true,
        bridgeConnected: true,
        bootstrapped: true,
      });
    } finally {
      bridge.stop();
    }
  });
});
