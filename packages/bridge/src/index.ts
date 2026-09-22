import {
  WATERLOOWORKS_ORIGIN,
  type BridgeHealth,
  type BridgeRequest,
  type BridgeResponse,
  type WaterlooWorksSession,
} from "../../shared/src/protocol.js";
import { runNativeMessageLoop, writeNativeMessage } from "./native-messaging.js";

const DEFAULT_PORT = 39451;
const SESSION_REQUEST_TIMEOUT_MS = 10_000;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ event, ...fields }));
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

class BridgeState {
  private session: WaterlooWorksSession | undefined;
  private nativeConnected = true;
  private pendingRequest: Promise<WaterlooWorksSession> | undefined;
  private resolvePending: ((session: WaterlooWorksSession) => void) | undefined;
  private rejectPending: ((error: Error) => void) | undefined;
  private pendingTimeout: ReturnType<typeof setTimeout> | undefined;

  markDisconnected(): void {
    this.nativeConnected = false;
    this.rejectPending?.(new Error("Browser native messaging connection closed"));
    this.clearPending();
  }

  setSession(session: WaterlooWorksSession): void {
    this.session = session;
    this.resolvePending?.(session);
    this.clearPending();
    log("session.received", { cookieCount: session.cookies.length });
  }

  failPending(message = "The browser extension could not provide a WaterlooWorks session"): void {
    this.rejectPending?.(new Error(message));
    this.clearPending();
  }

  health(): BridgeHealth {
    return {
      bridgeConnected: this.nativeConnected,
      sessionAvailable: this.session !== undefined,
      cookieCount: this.session?.cookies.length ?? 0,
    };
  }

  async getSession(forceRefresh: boolean): Promise<WaterlooWorksSession> {
    if (!forceRefresh && this.session) return this.session;
    if (!this.nativeConnected) throw new Error("Browser native messaging connection is unavailable");
    if (this.pendingRequest) return this.pendingRequest;

    let pendingResolve!: (session: WaterlooWorksSession) => void;
    let pendingReject!: (error: Error) => void;
    const pending = new Promise<WaterlooWorksSession>((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;
    });
    this.pendingRequest = pending;
    this.resolvePending = pendingResolve;
    this.rejectPending = pendingReject;
    this.pendingTimeout = setTimeout(() => {
      pendingReject(new Error("Timed out waiting for the browser extension session"));
      this.clearPending();
    }, SESSION_REQUEST_TIMEOUT_MS);

    try {
      await writeNativeMessage({ type: "get-waterlooworks-session" });
      return await pending;
    } finally {
      if (this.pendingRequest === pending) this.clearPending();
    }
  }

  private clearPending(): void {
    if (this.pendingTimeout) clearTimeout(this.pendingTimeout);
    this.pendingTimeout = undefined;
    this.resolvePending = undefined;
    this.rejectPending = undefined;
    this.pendingRequest = undefined;
  }
}

function parseBoolean(value: string | null): boolean {
  return value === "1" || value === "true";
}

export function createBridgeServer(state: BridgeState, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(state.health());
      }

      if (request.method === "GET" && url.pathname === "/session") {
        try {
          const session = await state.getSession(parseBoolean(url.searchParams.get("refresh")));
          return jsonResponse(session);
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : "Unable to obtain browser session" },
            503,
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/") {
        return jsonResponse({ service: "waterlooworks-bridge", origin: WATERLOOWORKS_ORIGIN });
      }

      return jsonResponse({ error: "Not found" }, 404);
    },
  });
}

async function handleNativeMessage(state: BridgeState, message: BridgeResponse): Promise<void> {
  if (message.type === "waterlooworks-session") {
    state.setSession({ cookies: message.cookies, obtainedAt: message.obtainedAt });
    return;
  }
  if (message.type === "pong") return;
  state.failPending();
  log("extension.error");
}

async function main(): Promise<void> {
  const configuredPort = Number(Bun.env.WATERLOOWORKS_BRIDGE_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65_535) {
    throw new Error("WATERLOOWORKS_BRIDGE_PORT must be an integer between 1024 and 65535");
  }

  const state = new BridgeState();
  const server = createBridgeServer(state, configuredPort);
  log("bridge.listening", { host: "127.0.0.1", port: server.port });

  try {
    await runNativeMessageLoop((message) => handleNativeMessage(state, message));
  } finally {
    state.markDisconnected();
    server.stop();
    log("bridge.closed");
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    log("bridge.error", { message: error instanceof Error ? error.message : "unknown error" });
    process.exitCode = 1;
  });
}

export { BridgeState };
