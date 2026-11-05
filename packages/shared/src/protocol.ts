export const WATERLOOWORKS_ORIGIN = "https://waterlooworks.uwaterloo.ca";
export const WATERLOOWORKS_JOBS_PATH = "/myAccount/co-op/full/jobs.htm";
export const WATERLOOWORKS_JOBS_URL = `${WATERLOOWORKS_ORIGIN}${WATERLOOWORKS_JOBS_PATH}`;
export const LOOPBACK_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 39_451;
export const DEFAULT_BRIDGE_BASE_URL = `http://${LOOPBACK_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`;

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

export function isWaterlooWorksSession(value: unknown): value is WaterlooWorksSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<WaterlooWorksSession>;
  return (
    Array.isArray(session.cookies) &&
    typeof session.obtainedAt === "string" &&
    session.cookies.every(isBrowserCookie)
  );
}
