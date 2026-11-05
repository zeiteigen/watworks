import {
  isWaterlooWorksSession,
  LOOPBACK_BRIDGE_HOST,
  type WaterlooWorksSession,
  WATERLOOWORKS_ORIGIN,
} from "../../shared/src/protocol.js";
import { BridgeState } from "./state.js";
import { createExtensionBridgeServer } from "./extension-broker.js";

const MAX_SESSION_BODY_BYTES = 512 * 1024;

export interface BridgeServerOptions {
  /** Restrict posts to one known extension ID when a packaged ID is available. */
  extensionOrigin?: string;
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function noContentResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

function isAllowedExtensionOrigin(origin: string | null, expectedOrigin: string | undefined): boolean {
  if (!origin) return false;
  if (expectedOrigin !== undefined) return origin === expectedOrigin;

  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "chrome-extension:" &&
      /^[a-p]{32}$/.test(parsed.hostname) &&
      (parsed.pathname === "" || parsed.pathname === "/")
    );
  } catch {
    return false;
  }
}

function extensionCorsHeaders(origin: string | null, expectedOrigin: string | undefined): Record<string, string> {
  if (origin === null || !isAllowedExtensionOrigin(origin, expectedOrigin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function extensionError(
  message: string,
  status: number,
  origin: string | null,
  expectedOrigin: string | undefined,
): Response {
  return jsonResponse({ error: message }, status, extensionCorsHeaders(origin, expectedOrigin));
}

function isWaterlooWorksCookieDomain(domain: string): boolean {
  return domain.replace(/^\./, "").toLowerCase() === "waterlooworks.uwaterloo.ca";
}

function normalizeSession(value: unknown): WaterlooWorksSession | undefined {
  if (!isWaterlooWorksSession(value)) return undefined;
  if (!value.cookies.every((cookie) => isWaterlooWorksCookieDomain(cookie.domain))) return undefined;
  return {
    cookies: value.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    })),
    obtainedAt: value.obtainedAt,
  };
}

async function readSession(request: Request): Promise<WaterlooWorksSession | undefined> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return undefined;

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_SESSION_BODY_BYTES) return undefined;

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_SESSION_BODY_BYTES) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return normalizeSession(parsed);
}

export function createBridgeFetch(
  state: BridgeState,
  options: BridgeServerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS" && url.pathname === "/session") {
      if (!isAllowedExtensionOrigin(origin, options.extensionOrigin)) {
        return extensionError(
          "Only a Chromium extension may use this endpoint",
          403,
          origin,
          options.extensionOrigin,
        );
      }
      return noContentResponse(204, extensionCorsHeaders(origin, options.extensionOrigin));
    }

    if (request.method === "POST" && url.pathname === "/session") {
      if (!isAllowedExtensionOrigin(origin, options.extensionOrigin)) {
        return extensionError(
          "Only a Chromium extension may use this endpoint",
          403,
          origin,
          options.extensionOrigin,
        );
      }
      const session = await readSession(request);
      if (!session) {
        return extensionError(
          "The browser extension sent an invalid WaterlooWorks session",
          400,
          origin,
          options.extensionOrigin,
        );
      }
      state.setSession(session);
      return noContentResponse(204, extensionCorsHeaders(origin, options.extensionOrigin));
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(state.health());
    }

    if (request.method === "GET" && url.pathname === "/session") {
      try {
        const session = await state.getSession(url.searchParams.get("refresh") === "1");
        return jsonResponse(session);
      } catch (error) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : "Unable to obtain browser session" },
          503,
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({ service: "waterlooworks-bridge", origin: WATERLOOWORKS_ORIGIN, transport: "http" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  };
}

export function createBridgeServer(
  state: BridgeState,
  port: number,
  options: BridgeServerOptions = {},
): Omit<ReturnType<typeof createExtensionBridgeServer>, "stop"> & { port: number; stop(force?: boolean): Promise<void> } {
  void state; void options;
  const bridge = createExtensionBridgeServer(port);
  const stop = bridge.stop;
  return Object.assign(bridge, { port: bridge.server.port!, stop: (_force?: boolean) => stop() });
}
