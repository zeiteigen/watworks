import type { BridgeHealth, BrowserCookie, WaterlooWorksSession } from "../../shared/src/protocol.js";

function cloneCookie(cookie: BrowserCookie): BrowserCookie {
  return { ...cookie };
}

function cloneSession(session: WaterlooWorksSession): WaterlooWorksSession {
  return {
    cookies: session.cookies.map(cloneCookie),
    obtainedAt: session.obtainedAt,
  };
}

/** In-memory browser-session state shared by the HTTP routes. */
export class BridgeState {
  private session: WaterlooWorksSession | undefined;

  setSession(session: WaterlooWorksSession): void {
    this.session = cloneSession(session);
    console.error(JSON.stringify({ event: "session.received", cookieCount: session.cookies.length }));
  }

  health(): BridgeHealth {
    return {
      bridgeConnected: true,
      sessionAvailable: this.session !== undefined,
      cookieCount: this.session?.cookies.length ?? 0,
    };
  }

  async getSession(_forceRefresh = false): Promise<WaterlooWorksSession> {
    if (!this.session) throw new Error("The browser extension has not provided a WaterlooWorks session");
    return cloneSession(this.session);
  }
}
