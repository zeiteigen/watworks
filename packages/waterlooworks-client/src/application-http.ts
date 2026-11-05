import { AsyncLocalStorage } from "node:async_hooks";
import { ReviewBeforeMutationError } from "../../approval/src/types.js";
import type { BrowserCookie, WaterlooWorksSession } from "../../shared/src/protocol.js";
import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";
import type { FetchLike, SessionProvider } from "./session.js";
import { AuthenticationExpiredError, ProtocolChangedError, WaterlooWorksServerError } from "./errors.js";

export const APPLICATION_PATH = "/myAccount/co-op/full/jobs.htm";
export const DOCUMENT_PATH = "/myAccount/co-op/full/documents.htm";

function header(cookies: BrowserCookie[]): string {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
}

/** Requests are single-shot. A returned error never authorizes replaying a write. */
export class ApplicationHttp {
  private readonly mutations = new AsyncLocalStorage<{ attempted: boolean }>();

  withMutationTracking<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutations.getStore()) return operation();
    return this.mutations.run({ attempted: false }, async () => {
      try { return await operation(); }
      catch (error) {
        if (!this.mutations.getStore()!.attempted) {
          throw new ReviewBeforeMutationError(error instanceof AuthenticationExpiredError
            ? "WaterlooWorks signed out before any write. Sign in and prepare a new review."
            : "Preflight failed before any remote write. Prepare a new review.", undefined,
            error instanceof AuthenticationExpiredError ? "authentication_expired" : "no_remote_mutation");
        }
        throw error;
      }
    });
  }

  /** Only verified data/form reads may use this, including the site's read-only POST routes. */
  read(session: WaterlooWorksSession, path: typeof APPLICATION_PATH | typeof DOCUMENT_PATH, body?: URLSearchParams, query = false): Promise<string> {
    return this.request(session, path, body, query, true);
  }

  constructor(private readonly provider: SessionProvider, private readonly fetchImpl: FetchLike = fetch) {}

  async session(): Promise<WaterlooWorksSession> {
    const session = await this.provider.getSession();
    if (!session.cookies.length || session.cookies.some(c => c.domain.replace(/^\./, "").toLowerCase() !== "waterlooworks.uwaterloo.ca" || /[\r\n;]/.test(c.name) || /[\r\n;]/.test(c.value))) throw new AuthenticationExpiredError();
    return structuredClone(session);
  }

  async request(session: WaterlooWorksSession, path: typeof APPLICATION_PATH | typeof DOCUMENT_PATH, body?: URLSearchParams | FormData, query = false, readOnly = false): Promise<string> {
    if (path !== APPLICATION_PATH && path !== DOCUMENT_PATH) throw new ProtocolChangedError("Unsupported application destination");
    if (query && !(body instanceof URLSearchParams)) throw new ProtocolChangedError("Invalid read query");
    let response: Response;
    // Mark before dispatch: redirects, timeouts and interrupted responses after a POST remain uncertain.
    const boundary = this.mutations.getStore();
    if (boundary && body !== undefined && !query && !readOnly) boundary.attempted = true;
    try { response = await this.fetchImpl(`${WATERLOOWORKS_ORIGIN}${path}${query ? `?${body!.toString()}` : ""}`, {
      method: body === undefined || query ? "GET" : "POST", redirect: "manual",
      headers: { cookie: header(session.cookies), origin: WATERLOOWORKS_ORIGIN, referer: `${WATERLOOWORKS_ORIGIN}${path}`, "x-requested-with": "XMLHttpRequest" },
      ...(body === undefined || query ? {} : { body }), signal: AbortSignal.timeout(30_000),
    }); } catch { throw new WaterlooWorksServerError("Application request failed; do not replay a write with an uncertain outcome"); }
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new AuthenticationExpiredError();
    if (!response.ok) throw new WaterlooWorksServerError(`Application operation returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 12_000_000) { await reader.cancel(); throw new ProtocolChangedError("Application response exceeded size limit"); }
          chunks.push(part.value);
        }
      } catch (error) {
        if (error instanceof ProtocolChangedError) throw error;
        throw new WaterlooWorksServerError("Application response was interrupted; outcome may be unknown");
      }
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    const buffer = joined.buffer;
    const prefix = new TextDecoder().decode(buffer.slice(0, 2048));
    const encoding = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1]
      ?? /charset\s*=\s*["']?([\w-]+)/i.exec(prefix)?.[1] ?? "utf-8";
    const text = new TextDecoder(encoding).decode(buffer);
    if (/<input[^>]+type=["']password/i.test(text) || /<title>[^<]*(?:Sign In|Not Logged In)/i.test(text)) throw new AuthenticationExpiredError();
    return text;
  }
}
