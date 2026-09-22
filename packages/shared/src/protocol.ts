export const WATERLOOWORKS_ORIGIN = "https://waterlooworks.uwaterloo.ca";
export const WATERLOOWORKS_JOBS_PATH = "/myAccount/co-op/full/jobs.htm";
export const WATERLOOWORKS_JOBS_URL = `${WATERLOOWORKS_ORIGIN}${WATERLOOWORKS_JOBS_PATH}`;

/**
 * The smallest cookie representation needed to recreate a Cookie header.
 * Values are credentials and must stay inside the local bridge/client path.
 */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

export interface WaterlooWorksSession {
  cookies: BrowserCookie[];
  obtainedAt: string;
}

export type BridgeRequest =
  | { type: "get-waterlooworks-session" }
  | { type: "ping" };

export type BridgeResponse =
  | {
      type: "waterlooworks-session";
      cookies: BrowserCookie[];
      obtainedAt: string;
    }
  | { type: "pong" }
  | { type: "error"; message: string };

export interface BridgeHealth {
  bridgeConnected: boolean;
  sessionAvailable: boolean;
  cookieCount: number;
}

export function isBrowserCookie(value: unknown): value is BrowserCookie {
  if (!value || typeof value !== "object") return false;
  const cookie = value as Partial<BrowserCookie>;
  return (
    typeof cookie.name === "string" &&
    typeof cookie.value === "string" &&
    typeof cookie.domain === "string" &&
    typeof cookie.path === "string" &&
    typeof cookie.secure === "boolean" &&
    typeof cookie.httpOnly === "boolean"
  );
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "get-waterlooworks-session" || type === "ping";
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const response = value as { type?: unknown; cookies?: unknown; obtainedAt?: unknown; message?: unknown };
  if (response.type === "waterlooworks-session") {
    return (
      Array.isArray(response.cookies) &&
      typeof response.obtainedAt === "string" &&
      response.cookies.every(isBrowserCookie)
    );
  }
  if (response.type === "error") return typeof response.message === "string";
  return response.type === "pong";
}
