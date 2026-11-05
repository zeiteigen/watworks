import { describe, expect, test } from "bun:test";
import { BridgeState, createBridgeFetch } from "./index.js";

const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;

function session() {
  return {
    cookies: [
      {
        name: "WW_SESSION",
        value: "redacted-test-value",
        domain: ".waterlooworks.uwaterloo.ca",
        path: "/",
        secure: true,
        httpOnly: true,
      },
    ],
    obtainedAt: "2026-09-23T00:00:00.000Z",
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

describe("loopback bridge HTTP transport", () => {
  test("accepts extension CORS preflight and session delivery", async () => {
    const handle = createBridgeFetch(new BridgeState());
    const preflight = await handle(
      request("/session", {
        method: "OPTIONS",
        headers: {
          origin: extensionOrigin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(extensionOrigin);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");

    const response = await handle(
      request("/session", {
        method: "POST",
        headers: { origin: extensionOrigin, "content-type": "application/json" },
        body: JSON.stringify(session()),
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(extensionOrigin);
  });

  test("serves the latest posted session and health over the client endpoints", async () => {
    const state = new BridgeState();
    const handle = createBridgeFetch(state);
    state.setSession(session());

    const health = await handle(request("/health"));
    await expect(health.json()).resolves.toEqual({
      bridgeConnected: true,
      sessionAvailable: true,
      cookieCount: 1,
    });

    const response = await handle(request("/session?refresh=1"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(session());
  });

  test("rejects non-extension origins and foreign cookies", async () => {
    const handle = createBridgeFetch(new BridgeState());
    const missingOrigin = await handle(
      request("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(session()),
      }),
    );
    expect(missingOrigin.status).toBe(403);

    const foreignOrigin = await handle(
      request("/session", {
        method: "POST",
        headers: { origin: "https://example.com", "content-type": "application/json" },
        body: JSON.stringify(session()),
      }),
    );
    expect(foreignOrigin.status).toBe(403);

    const foreignCookies = session();
    foreignCookies.cookies[0]!.domain = "example.com";
    const foreignCookieResponse = await handle(
      request("/session", {
        method: "POST",
        headers: { origin: extensionOrigin, "content-type": "application/json" },
        body: JSON.stringify(foreignCookies),
      }),
    );
    expect(foreignCookieResponse.status).toBe(400);
  });
});
