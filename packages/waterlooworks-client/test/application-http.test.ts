import { describe, expect, spyOn, test } from "bun:test";
import { ApplicationHttp, APPLICATION_PATH, DOCUMENT_PATH } from "../src/application-http.js";
import { AuthenticationExpiredError, ProtocolChangedError, WaterlooWorksServerError } from "../src/errors.js";
import { createStaticSession, type FetchLike } from "../src/session.js";

const session = createStaticSession([{ name: "WW_SESSION", value: "synthetic-test-cookie", domain: "waterlooworks.uwaterloo.ca", path: "/", secure: true, httpOnly: true }]);
function http(fetchImpl: FetchLike) { return new ApplicationHttp({ getSession: async () => session }, fetchImpl); }

describe("single-shot application transport", () => {
  test("uses only allowlisted destinations with manual redirects and scoped session headers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = http(async (input, init) => { calls.push({ url: String(input), ...(init ? { init } : {}) }); return new Response("ok"); });
    await transport.request(session, APPLICATION_PATH);
    await transport.request(session, DOCUMENT_PATH, new URLSearchParams({ action: "synthetic-write" }));
    expect(calls.map(call => call.url)).toEqual([`https://waterlooworks.uwaterloo.ca${APPLICATION_PATH}`, `https://waterlooworks.uwaterloo.ca${DOCUMENT_PATH}`]);
    expect(calls.map(call => call.init?.method)).toEqual(["GET", "POST"]);
    expect(calls.every(call => call.init?.redirect === "manual" && call.init.signal instanceof AbortSignal)).toBe(true);
    expect(new Headers(calls[0]?.init?.headers).get("cookie")).toBe("WW_SESSION=synthetic-test-cookie");
    await expect(transport.request(session, "https://attacker.invalid/documents.htm" as typeof DOCUMENT_PATH)).rejects.toBeInstanceOf(ProtocolChangedError);
    await expect(transport.request(session, "/other.htm" as typeof DOCUMENT_PATH)).rejects.toBeInstanceOf(ProtocolChangedError);
    await expect(transport.request(session, DOCUMENT_PATH, new FormData(), true)).rejects.toBeInstanceOf(ProtocolChangedError);
    expect(calls).toHaveLength(2);
  });

  test.each([301, 302, 307, 308, 401, 403])("does not follow or retry HTTP %s", async status => {
    let calls = 0;
    const transport = http(async () => { calls++; return new Response("sensitive response", { status, headers: { location: "https://attacker.invalid" } }); });
    await expect(transport.request(session, DOCUMENT_PATH, new URLSearchParams({ action: "write" }))).rejects.toBeInstanceOf(AuthenticationExpiredError);
    expect(calls).toBe(1);
  });

  test.each([429, 500, 503])("does not retry server error %s or expose its body", async status => {
    let calls = 0;
    const transport = http(async () => { calls++; return new Response("SECRET-TRANSPORT-BODY", { status }); });
    try { await transport.request(session, APPLICATION_PATH, new FormData()); throw new Error("Expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(WaterlooWorksServerError); expect(String(error)).not.toContain("SECRET-TRANSPORT-BODY"); }
    expect(calls).toBe(1);
  });

  test.each(['<input type="password" name="password">', "<title>Sign In</title>", "<title>Not Logged In</title>"])("rejects login response %s without retries", async body => {
    let calls = 0;
    const transport = http(async () => { calls++; return new Response(body); });
    await expect(transport.request(session, DOCUMENT_PATH)).rejects.toBeInstanceOf(AuthenticationExpiredError);
    expect(calls).toBe(1);
  });

  test("transport failure and timeout never replay a write", async () => {
    let calls = 0;
    const transport = http(async () => { calls++; throw new TypeError("Network unavailable"); });
    await expect(transport.request(session, DOCUMENT_PATH, new FormData())).rejects.toThrow("do not replay");
    expect(calls).toBe(1);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      expect(milliseconds).toBe(30_000);
      return AbortSignal.abort(new DOMException("Synthetic timeout", "TimeoutError"));
    });
    try {
      const timed = http(async (_url, init) => { calls++; init?.signal?.throwIfAborted(); return new Response("unexpected"); });
      await expect(timed.request(session, DOCUMENT_PATH, new FormData())).rejects.toThrow("do not replay");
      expect(calls).toBe(2);
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });

  test("validates and copies session cookies before use", async () => {
    const transport = http(async () => new Response("ok"));
    const copy = await transport.session();
    copy.cookies[0]!.value = "changed";
    expect(session.cookies[0]!.value).toBe("synthetic-test-cookie");
    for (const cookies of [[], [{ ...session.cookies[0]!, domain: "attacker.invalid" }], [{ ...session.cookies[0]!, value: "injected;cookie" }], [{ ...session.cookies[0]!, name: "bad\r\nheader" }]]) {
      const invalid = new ApplicationHttp({ getSession: async () => ({ ...session, cookies }) });
      await expect(invalid.session()).rejects.toBeInstanceOf(AuthenticationExpiredError);
    }
  });

  test.each(["header", "meta"])("decodes ISO-8859-1 specified by %s", async source => {
    const html = `${source === "meta" ? '<meta charset="ISO-8859-1">' : ""}<p>Résumé</p>`;
    const transport = http(async () => new Response(Buffer.from(html, "latin1"), source === "header" ? { headers: { "content-type": "text/html; charset=ISO-8859-1" } } : undefined));
    expect(await transport.request(session, DOCUMENT_PATH)).toBe(html);
  });

  test("bounds response size", async () => {
    const transport = http(async () => new Response(new Uint8Array(12_000_001)));
    await expect(transport.request(session, DOCUMENT_PATH)).rejects.toThrow("size limit");
  });
});

describe('mutation tracking during logout', () => {
  test.each([302, 401, 403])('logout HTTP %s during verified preflight reads proves no write', async status => {
    const transport = http(async () => new Response(null, { status }));
    const failure = await transport.withMutationTracking(() => transport.read(session, APPLICATION_PATH, new URLSearchParams({ action: 'verified-data-read' }))).catch(error => error);
    expect(failure.name).toBe('ReviewBeforeMutationError');
    expect(failure.code).toBe('authentication_expired');
  });

  test.each([302, 401, 403])('logout HTTP %s after a write dispatch remains uncertain', async status => {
    let writes = 0;
    const transport = http(async () => { writes++; return new Response(null, { status }); });
    const failure = await transport.withMutationTracking(() => transport.request(session, APPLICATION_PATH, new URLSearchParams({ action: 'commit' }))).catch(error => error);
    expect(failure).toBeInstanceOf(AuthenticationExpiredError);
    expect(writes).toBe(1);
  });

  test('lost write response or logout on a later read cannot become a no-write failure', async () => {
    for (const lost of [false, true]) {
      const transport = http(async (_input, init) => {
        if (init?.body instanceof FormData) {
          if (lost) throw Error('connection lost');
          return new Response('ok');
        }
        return new Response(null, { status: 302 });
      });
      const error = await transport.withMutationTracking(async () => {
        await transport.request(session, DOCUMENT_PATH, new FormData());
        return transport.read(session, DOCUMENT_PATH);
      }).catch(error => error);
      expect(error.name).not.toBe('ReviewBeforeMutationError');
    }
  });

  test('concurrent executions have independent write tracking', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transport = http(async (_input, init) => {
      if (init?.method === 'POST') { await gate; return new Response(null, { status: 302 }); }
      return new Response(null, { status: 302 });
    });
    const writing = transport.withMutationTracking(() => transport.request(session, APPLICATION_PATH, new FormData())).catch(error => error);
    const reading = await transport.withMutationTracking(() => transport.read(session, APPLICATION_PATH)).catch(error => error);
    expect(reading.name).toBe('ReviewBeforeMutationError');
    release();
    expect(await writing).toBeInstanceOf(AuthenticationExpiredError);
  });
});
