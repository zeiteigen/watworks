export type WaterlooWorksErrorCode =
  | "AUTHENTICATION_EXPIRED"
  | "PROTOCOL_CHANGED"
  | "SERVER_ERROR"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "BRIDGE_UNAVAILABLE";

export class WaterlooWorksError extends Error {
  readonly code: WaterlooWorksErrorCode;

  constructor(code: WaterlooWorksErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "WaterlooWorksError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export class AuthenticationExpiredError extends WaterlooWorksError {
  constructor(message = "The WaterlooWorks browser session is not authenticated", cause?: unknown) {
    super("AUTHENTICATION_EXPIRED", message, cause);
    this.name = "AuthenticationExpiredError";
  }
}

export class ProtocolChangedError extends WaterlooWorksError {
  constructor(message: string, cause?: unknown) {
    super("PROTOCOL_CHANGED", message, cause);
    this.name = "ProtocolChangedError";
  }
}

export class WaterlooWorksServerError extends WaterlooWorksError {
  constructor(message: string, cause?: unknown) {
    super("SERVER_ERROR", message, cause);
    this.name = "WaterlooWorksServerError";
  }
}

export class RateLimitedError extends WaterlooWorksError {
  constructor(message = "WaterlooWorks rate-limited the request", cause?: unknown) {
    super("RATE_LIMITED", message, cause);
    this.name = "RateLimitedError";
  }
}

export class InvalidRequestError extends WaterlooWorksError {
  constructor(message: string, cause?: unknown) {
    super("INVALID_REQUEST", message, cause);
    this.name = "InvalidRequestError";
  }
}

export class BridgeUnavailableError extends WaterlooWorksError {
  constructor(message = "The local WaterlooWorks browser bridge is unavailable", cause?: unknown) {
    super("BRIDGE_UNAVAILABLE", message, cause);
    this.name = "BridgeUnavailableError";
  }
}

export function isRefreshableError(error: unknown): error is WaterlooWorksError {
  return (
    error instanceof WaterlooWorksError &&
    (error.code === "AUTHENTICATION_EXPIRED" || error.code === "PROTOCOL_CHANGED")
  );
}
