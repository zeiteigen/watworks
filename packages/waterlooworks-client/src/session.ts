import {
  DEFAULT_BRIDGE_BASE_URL,
  WATERLOOWORKS_ORIGIN,
  type BrowserCookie,
  type BridgeHealth,
  type WaterlooWorksSession,
} from "../../shared/src/protocol.js";
import { BridgeUnavailableError, InvalidRequestError, ProtocolChangedError } from "./errors.js";

export interface SessionRequestOptions {
  forceRefresh?: boolean;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SessionProvider {
  getSession(options?: SessionRequestOptions): Promise<WaterlooWorksSession>;
}

export interface HealthAwareSessionProvider extends SessionProvider {
  health(): Promise<BridgeHealth>;
}

export interface BrowserExtensionSessionProviderOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCookie(value: unknown): BrowserCookie {
  if (!isRecord(value)) throw new ProtocolChangedError("The browser bridge returned an invalid cookie");
  const name = typeof value.name === "string" ? value.name : undefined;
  const cookieValue = typeof value.value === "string" ? value.value : undefined;
  const domain = typeof value.domain === "string" ? value.domain : undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  if (name === undefined || cookieValue === undefined || domain === undefined || path === undefined) {
    throw new ProtocolChangedError("The browser bridge cookie is missing a required string field");
  }
  if (typeof value.secure !== "boolean" || typeof value.httpOnly !== "boolean") {
    throw new ProtocolChangedError("The browser bridge cookie has invalid flags");
  }
  const cookie: BrowserCookie = {
    name,
    value: cookieValue,
    domain,
    path,
    secure: value.secure,
    httpOnly: value.httpOnly,
  };
  return cookie;
}

function parseSession(value: unknown): WaterlooWorksSession {
  if (!isRecord(value) || !Array.isArray(value.cookies) || typeof value.obtainedAt !== "string") {
    throw new ProtocolChangedError("The browser bridge returned an invalid WaterlooWorks session");
  }
  const cookies = value.cookies.map(parseCookie);
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    if (domain !== "waterlooworks.uwaterloo.ca") {
      throw new ProtocolChangedError("The browser bridge returned a cookie outside WaterlooWorks");
    }
  }
  return { cookies, obtainedAt: value.obtainedAt };
}

function parseHealth(value: unknown): BridgeHealth {
  if (
    !isRecord(value) ||
    typeof value.bridgeConnected !== "boolean" ||
    typeof value.sessionAvailable !== "boolean" ||
    typeof value.cookieCount !== "number" ||
    !Number.isInteger(value.cookieCount) ||
    value.cookieCount < 0
  ) {
    throw new ProtocolChangedError("The browser bridge returned invalid health data");
  }
  return {
    bridgeConnected: value.bridgeConnected,
    sessionAvailable: value.sessionAvailable,
    cookieCount: value.cookieCount,
  };
}

export class BrowserExtensionSessionProvider implements HealthAwareSessionProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: BrowserExtensionSessionProviderOptions = {}) {
    this.baseUrl = validateBridgeBaseUrl(
      options.baseUrl ?? DEFAULT_BRIDGE_BASE_URL,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getSession(options: SessionRequestOptions = {}): Promise<WaterlooWorksSession> {
    const path = options.forceRefresh ? "/session?refresh=1" : "/session";
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`);
    } catch (error) {
      throw new BridgeUnavailableError("Unable to connect to the local browser bridge", error);
    }

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new BridgeUnavailableError(
        message && message.length < 300 ? message : "The browser bridge could not provide a session",
      );
    }
    try {
      return parseSession(await response.json());
    } catch (error) {
      if (error instanceof ProtocolChangedError) throw error;
      throw new ProtocolChangedError("The browser bridge returned invalid session JSON", error);
    }
  }

  async health(): Promise<BridgeHealth> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/health`);
    } catch (error) {
      throw new BridgeUnavailableError("Unable to connect to the local browser bridge", error);
    }
    if (!response.ok) throw new BridgeUnavailableError("The local browser bridge returned an error");
    try {
      return parseHealth(await response.json());
    } catch (error) {
      if (error instanceof ProtocolChangedError) throw error;
      throw new ProtocolChangedError("The browser bridge returned invalid health JSON", error);
    }
  }
}

function validateBridgeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new InvalidRequestError("bridge baseUrl must be a valid loopback HTTP URL", error);
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "http:" || !loopbackHosts.has(hostname) || parsed.username || parsed.password) {
    throw new InvalidRequestError("bridge baseUrl must use HTTP on localhost or a loopback address");
  }
  return parsed.origin;
}

/** Development-only provider. It never persists or logs the supplied cookies. */
export class StaticCookieSessionProvider implements SessionProvider {
  constructor(private readonly session: WaterlooWorksSession) {}

  async getSession(_options: SessionRequestOptions = {}): Promise<WaterlooWorksSession> {
    return this.session;
  }
}

export function createStaticSession(cookies: BrowserCookie[]): WaterlooWorksSession {
  return {
    cookies,
    obtainedAt: new Date().toISOString(),
  };
}

export function assertWaterlooWorksOrigin(url: string): void {
  const parsed = new URL(url);
  if (parsed.origin !== WATERLOOWORKS_ORIGIN) {
    throw new ProtocolChangedError("WaterlooWorks request left the expected origin");
  }
}
