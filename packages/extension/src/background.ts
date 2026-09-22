import {
  WATERLOOWORKS_JOBS_URL,
  isBridgeRequest,
  type BrowserCookie,
} from "../../shared/src/protocol.js";

const NATIVE_HOST_NAME = "com.waterlooworks.mcp";

let nativePort: chrome.runtime.Port | undefined;
let sessionExportTimer: ReturnType<typeof setTimeout> | undefined;

function postNativeMessage(port: chrome.runtime.Port, message: unknown): boolean {
  if (nativePort !== port) return false;

  try {
    port.postMessage(message);
    return true;
  } catch {
    // The host can disconnect asynchronously between the identity check and
    // postMessage(). Do not try to report an error through the same dead port.
    if (nativePort === port) nativePort = undefined;
    return false;
  }
}

function isWaterlooWorksCookie(cookie: chrome.cookies.Cookie): boolean {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  return domain === "waterlooworks.uwaterloo.ca";
}

function narrowCookie(cookie: chrome.cookies.Cookie): BrowserCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
}

async function exportSession(): Promise<void> {
  const port = nativePort;
  if (!port) return;

  try {
    // Query the endpoint that the client actually calls. This includes cookies
    // scoped to /myAccount, which a root-URL lookup would omit.
    const cookies = await chrome.cookies.getAll({ url: WATERLOOWORKS_JOBS_URL });
    postNativeMessage(port, {
      type: "waterlooworks-session",
      cookies: cookies.filter(isWaterlooWorksCookie).map(narrowCookie),
      obtainedAt: new Date().toISOString(),
    });
  } catch {
    postNativeMessage(port, { type: "error", message: "Unable to read WaterlooWorks cookies" });
  }
}

function scheduleSessionExport(): void {
  if (sessionExportTimer !== undefined) clearTimeout(sessionExportTimer);
  sessionExportTimer = setTimeout(() => {
    sessionExportTimer = undefined;
    if (!nativePort) {
      connectNative();
      return;
    }
    void exportSession().catch(() => undefined);
  }, 100);
}

function handleNativeMessage(message: unknown): void {
  if (!isBridgeRequest(message)) return;
  const request = message;
  if (request.type === "get-waterlooworks-session") {
    void exportSession().catch(() => undefined);
  } else if (request.type === "ping") {
    const port = nativePort;
    if (port) postNativeMessage(port, { type: "pong" });
  }
}

function connectNative(): void {
  if (nativePort) return;

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    port.onMessage.addListener(handleNativeMessage);
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (error) console.warn(`Native messaging host disconnected: ${error.message}`);
      if (nativePort === port) nativePort = undefined;
    });
    void exportSession().catch(() => undefined);
  } catch {
    nativePort = undefined;
  }
}

chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
chrome.cookies.onChanged.addListener((changeInfo) => {
  if (isWaterlooWorksCookie(changeInfo.cookie)) scheduleSessionExport();
});
connectNative();
