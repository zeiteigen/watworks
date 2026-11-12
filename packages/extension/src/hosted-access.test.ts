import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { getHostedAccount } from "./insider-account.js";
import { hostedRequest } from "./hosted-client.js";
import { prepareHostedSubmissionSession } from "./hosted-session.js";
import { confirmSubmission, hostedJobPending } from "./hosted-queue.js";
import { HOSTED_INSIDER_SESSION_KEY } from "./insider-session.js";
import { browserResearch } from "./research.js";

const endpoint = "https://watworks.alishahzad.dev";
const originalFetch = globalThis.fetch;
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let local: Record<string, unknown>, session: Record<string, unknown>;
let requests: Array<{ url: string; init: RequestInit | undefined }>;
let invited: boolean, authStatus: number, importStatus: number;
let health: ReturnType<typeof spyOn>;
let confirmations: Array<{ jobId: string; finish: () => void }> = [];
function storage(data: Record<string, unknown>) {
  return { get: async (key: string) => ({ [key]: data[key] }), set: async (values: Record<string, unknown>) => { Object.assign(data, values); }, remove: async (key: string) => { delete data[key]; }, setAccessLevel: async () => {} };
}
beforeEach(() => {
  local = { "submission:settings": { endpoint: "http://127.0.0.1:39453", headers: { authorization: "Bearer local-secret" }, revision: crypto.randomUUID() } };
  session = {}; requests = []; invited = true; authStatus = 200; importStatus = 200;
  const cookie = crypto.randomUUID();
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: storage(local), session: storage(session) }, cookies: { getAll: async () => [{ name: "session", value: cookie, domain: "waterlooworks.uwaterloo.ca", path: "/", secure: true, httpOnly: true, sameSite: "lax" }] } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Test browser", locks: { request: async (_name: string, _options: unknown, task: () => Promise<void>) => task() } } });
  health = spyOn(browserResearch, "health").mockResolvedValue({ authenticated: true, bridgeConnected: true, bootstrapped: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    if (url === "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm") return new Response(String(init?.body).includes("action=") ? '<table><tr><td>Email Address:</td><td>student@uwaterloo.ca</td></tr></table>' : `<a onclick="orbisAppSr.buildForm({'action':'read-account'}, '', '').submit();">My Account</a>`);
    expect(url.startsWith(endpoint + "/v1/")).toBe(true);
    if (url.endsWith("/auth/waterlooworks")) return Response.json(authStatus === 200 ? { token: invited ? "f".repeat(64) : null, expiresAt: Date.now() + 3600000, account: { email: "student@uwaterloo.ca", insider: invited, term: "2026-fall", admin: false } } : { error: "Unavailable" }, { status: authStatus });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + "f".repeat(64));
    if (url.endsWith("/session")) return Response.json(importStatus === 200 ? { accountKey: "student", sessionId: "hosted-session" } : importStatus === 409 ? { error: "An operation is active" } : { code: "session_invalid", error: "Credentials rejected" }, { status: importStatus });
    if (url.endsWith("/account")) return Response.json({ email: "student@uwaterloo.ca", insider: invited, term: "2026-fall", admin: false });
    const confirm = /\/v1\/workspace\/jobs\/(\d+)\/confirm$/.exec(url);
    if (confirm) return new Promise<Response>(resolve => confirmations.push({ jobId: confirm[1]!, finish: () => resolve(Response.json({ status: "submitted" })) }));
    expect(url).toBe(endpoint + "/v1/workspace");
    return Response.json({ profile: null, resumes: [], jobs: [], runs: [], ai: { available: false, reason: "Connect ChatGPT" } });
  }) as typeof fetch;
});
afterEach(() => {
  health.mockRestore(); globalThis.fetch = originalFetch;
  for (const [name, descriptor] of [["chrome", originalChrome], ["navigator", originalNavigator]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

test("hosted workspace recognizes a grant independently of the local endpoint and credentials", async () => {
  const saved = structuredClone(local);
  expect(await hostedRequest()).toHaveProperty("jobs");
  expect(session[HOSTED_INSIDER_SESSION_KEY]).toMatchObject({ endpoint, email: "student@uwaterloo.ca" });
  expect(local).toEqual(saved);
  expect(requests.every(request => !request.url.startsWith("http://127.0.0.1"))).toBe(true);
  expect(requests.some(request => new Headers(request.init?.headers).get("authorization") === "Bearer local-secret")).toBe(false);
});

test("refresh immediately picks up an admin grant despite a cached denial", async () => {
  invited = false;
  expect((await getHostedAccount()).insider).toBe(false);
  invited = true;
  expect((await getHostedAccount()).insider).toBe(false);
  expect((await getHostedAccount(true)).insider).toBe(true);
});

test("verification outages retain their actual reason instead of claiming the user is uninvited", async () => {
  authStatus = 503;
  await expect(hostedRequest()).rejects.toThrow("Insider verification unavailable (HTTP 503)");
});

test("confirmed missing grants identify the verified email and term", async () => {
  invited = false;
  await expect(hostedRequest()).rejects.toThrow("No Insider access for student@uwaterloo.ca in 2026-fall");
});

test("hosted preparation imports directly to Cloudflare and preserves advanced settings", async () => {
  const saved = structuredClone(local);
  await prepareHostedSubmissionSession();
  const imports = requests.filter(request => request.url.endsWith("/session"));
  expect(imports).toHaveLength(1);
  expect(imports[0]!.url).toBe(endpoint + "/v1/session");
  expect(JSON.parse(String(imports[0]!.init?.body))).toMatchObject({ userAgent: "Test browser", cookies: [{ name: "session" }] });
  expect(local).toEqual(saved);
  expect(JSON.stringify(session)).not.toContain('"cookies"');
});

test("a session busy with another job counts as prepared, so queued writes wait behind it", async () => {
  importStatus = 409;
  await prepareHostedSubmissionSession();
  expect(requests.filter(request => request.url.endsWith("/session"))).toHaveLength(1);
});

test("signed-out preparation does not import credentials or open login", async () => {
  health.mockResolvedValue({ authenticated: false, bridgeConnected: true, bootstrapped: false });
  await expect(prepareHostedSubmissionSession()).rejects.toThrow("Sign in to WaterlooWorks");
  expect(requests).toHaveLength(0);
});

test("rejected hosted credentials are not resent until browser credentials change", async () => {
  importStatus = 400;
  await expect(prepareHostedSubmissionSession()).rejects.toThrow("Credentials rejected");
  await expect(prepareHostedSubmissionSession()).rejects.toThrow("credentials were rejected");
  expect(requests.filter(request => request.url.endsWith("/session"))).toHaveLength(1);
});

test("submissions clicked one after another leave this page one at a time, in order", async () => {
  confirmations = [];
  const chromeValue = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
  chromeValue.runtime = { sendMessage: async () => ({ ok: true }) };
  const hooks = { refresh: () => {}, report: () => {}, progress: () => {} };
  const job = (jobId: string) => ({ jobId, status: "confirm_required", manifestHash: "a".repeat(64), manifest: {} });
  const first = confirmSubmission(job("1"), hooks), second = confirmSubmission(job("2"), hooks);
  expect(hostedJobPending("2")).toBe("Queued to submit after 1 other application");
  const settle = async () => { for (let tick = 0; tick < 50 && confirmations.length < 1; tick++) await new Promise(resolve => setTimeout(resolve, 5)); };
  await settle();
  // The second has sent nothing while the first is still out.
  expect(confirmations.map(item => item.jobId)).toEqual(["1"]);
  confirmations.shift()!.finish(); await first;
  await settle();
  expect(confirmations.map(item => item.jobId)).toEqual(["2"]);
  expect(hostedJobPending("2")).toBe("Submitting… Do not retry if the result is uncertain.");
  confirmations.shift()!.finish(); await second;
  expect(hostedJobPending("2")).toBeUndefined();
});
