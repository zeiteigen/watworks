import { readInsiderSession } from "./insider-session.js";
import { BROWSER_STARTUP_FAILURES, type BrowserStartupCode } from "../../shared/src/browser-startup-failure.js";
import { z } from "zod";
import { EXTENSION_METHODS, validateExtensionArgs, type ExtensionMethod } from "../../shared/src/extension-protocol.js";
import { BrowserOperationError, operationFailureSchema } from "../../shared/src/operation-failure.js";
import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";
import { wireDecode, wireEncode } from "./wire.js";
import { unexpiredCookie } from "../../shared/src/session-cookies.js";
import { readCommandStream, COMMAND_STREAM_TYPE } from "../../shared/src/command-stream.js";
import type { ApplicationProgress } from "../../shared/src/application-progress.js";

export const DEFAULT_SUBMISSION_ENDPOINT = "https://watworks.alishahzad.dev";
const SETTINGS_KEY = "submission:settings", SESSION_KEY = "submission:session", DIRTY_KEY="submission:session-dirty";
const REJECTED_KEY="submission:rejected-session";
const settingsSchema = z.object({ endpoint: z.string(), headers: z.record(z.string(), z.string()), revision: z.string().uuid() }).strict();
const capabilitiesSchema = z.object({ version: z.literal(1), fillOnly: z.boolean(), binding: z.string().min(1).max(500), sessionAvailable: z.boolean().optional() });
const sessionSchema = z.object({ accountKey: z.string().min(1).max(200), sessionId: z.string().min(1).max(500) }).strict();
const storedSessionSchema = sessionSchema.extend({ revision: z.string().uuid(), serverBinding: z.string().min(1).max(500) }).strict();
export type SubmissionSettings = z.infer<typeof settingsSchema>;
export type SubmissionCapabilities = z.infer<typeof capabilitiesSchema>;
const MUTATIONS = new Set(["uploadDocument", "stageAttachments", "submitApplication", "fillApplication", "setDefaultDocuments"]);

/** Only trusted extension pages and the worker may access endpoint credentials. */
async function trustedStorage(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
}

export function validateSubmissionEndpoint(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Enter a complete submission server URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The submission endpoint must use HTTPS or loopback HTTP");
  if (url.username || url.password || url.search || url.hash) throw new Error("Endpoint URLs cannot contain credentials, queries, or fragments");
  return url.href.replace(/\/+$/, "");
}

export function validateSubmissionHeaders(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 32) throw new Error("Proxy headers must be a JSON object with at most 32 entries");
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(name) || typeof value !== "string" || value.length > 8192 || /[\r\n\x00]/.test(value)) throw new Error("Invalid proxy header");
    const lower = name.toLowerCase();
    if (/^(?:x-wat-|x-submission-user|x-forwarded-user|remote-user|proxy-|sec-)/.test(lower) || ["cookie", "cookie2", "set-cookie", "host", "origin", "referer", "user-agent", "content-type", "content-length", "connection", "transfer-encoding", "upgrade", "te", "trailer", "accept-encoding"].includes(lower)) throw new Error(`Header ${name} is reserved`);
    if (Object.hasOwn(result, lower)) throw new Error("Proxy header names must be unique");
    result[lower] = value;
  }
  return result;
}

export async function getSubmissionSettings(): Promise<SubmissionSettings> {
  await trustedStorage();
  const parsed = settingsSchema.safeParse((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
  if (parsed.success) return { ...parsed.data, endpoint: validateSubmissionEndpoint(parsed.data.endpoint), headers: validateSubmissionHeaders(parsed.data.headers) };
  const initial = { endpoint: DEFAULT_SUBMISSION_ENDPOINT, headers: {}, revision: "00000000-0000-4000-8000-000000000001" };
  return initial;
}

export async function saveSubmissionSettings(endpoint: string, headers: unknown): Promise<{ warning?: string }> {
  return settingsWrite(async () => {
    await trustedStorage();
    const settings = { endpoint: validateSubmissionEndpoint(endpoint), headers: validateSubmissionHeaders(headers), revision: crypto.randomUUID() };
    const previous = await getSubmissionSettings();
    const session = storedSessionSchema.safeParse((await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY]);
    let warning: string | undefined;
    if (session.success && session.data.revision === previous.revision) {
      try { await request(previous, "session", { method: "DELETE", headers: { "X-Wat-Session-Id": session.data.sessionId } }, Date.now() + 5_000); }
      catch { warning = "The previous server could not confirm session removal. Its session expires automatically within about 21 minutes of inactivity."; }
    }
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    await chrome.storage.session.remove(SESSION_KEY);
    return warning === undefined ? {} : { warning };
  });
}

const SETTINGS_LOCK = "submission:endpoint-use";
async function settingsWrite<T>(task: () => Promise<T>): Promise<T> {
  return navigator.locks.request(SETTINGS_LOCK, { mode: "exclusive", ifAvailable: true }, lock => {
    if (!lock) throw new Error("A submission request is active; wait before changing the endpoint or session");
    return task();
  });
}

/** Never probe a submission endpoint without local evidence of access. */
export function isSelfHostedSubmission(settings: SubmissionSettings): boolean {
  const endpoint = new URL(settings.endpoint);
  return ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    (endpoint.origin !== new URL(DEFAULT_SUBMISSION_ENDPOINT).origin && Boolean(settings.headers.authorization));
}
export async function hasSubmissionAccess(settings?: SubmissionSettings): Promise<boolean> {
  settings ??= await getSubmissionSettings();
  return isSelfHostedSubmission(settings) || Boolean(await readInsiderSession(settings));
}
async function requireSubmissionAccess(settings: SubmissionSettings): Promise<void> {
  if (await hasSubmissionAccess(settings)) return;
  // Agent preparation runs in the worker without opening an account UI. Restore
  // expired or cookie-invalidated identity evidence before deciding access.
  const { getInsiderAccount } = await import("./insider-account.js");
  const account = await getInsiderAccount();
  const latest = await getSubmissionSettings();
  if (latest.endpoint !== settings.endpoint || latest.revision !== settings.revision) throw new Error("Submission settings changed; prepare again");
  if (!await hasSubmissionAccess(settings)) throw new Error(account.reason ?? "Insider is required for server applications and discovery.");
}

async function request(settings: SubmissionSettings, path: string, init: RequestInit = {}, deadline = Date.now() + 15_000, onProgress?:(progress:ApplicationProgress)=>void): Promise<unknown> {
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error("Submission request expired");
  await requireSubmissionAccess(settings);
  if (deadline <= Date.now()) throw new Error("Submission request expired");
  const insider=await readInsiderSession(settings);
  const response = await fetch(`${settings.endpoint}/v1/${path}`, {
    ...init, headers: { ...settings.headers, ...(insider?{authorization:`Bearer ${insider.token}`} : {}), "Content-Type": "application/json", ...init.headers },
    credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(Math.min(deadline - Date.now(), 185_000)),
  });
  if(response.ok && response.headers.get("content-type")?.startsWith(COMMAND_STREAM_TYPE))return readCommandStream(response,onProgress);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new Error(response.ok ? "Submission server did not return JSON" : `Submission server returned HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 48_000_000) throw new Error("Submission response exceeded limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Submission server returned an empty response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 48_000_000) throw new Error("Submission response exceeded limit"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const result=JSON.parse(new TextDecoder().decode(bytes));
  if(!response.ok){
    if(typeof result?.code==="string" && Object.hasOwn(BROWSER_STARTUP_FAILURES,result.code))throw new Error(BROWSER_STARTUP_FAILURES[result.code as BrowserStartupCode]);
    if(result?.code==="session_invalid")throw new InvalidSubmissionSession();
    if(result?.code==="session_validation_unavailable")throw new Error("WaterlooWorks session validation is temporarily unavailable; try again later.");
    throw new Error(`Submission server returned HTTP ${response.status}`);
  }
  return result;
}

export async function submissionCapabilities(): Promise<SubmissionCapabilities> {
  return capabilitiesSchema.parse(await request(await getSubmissionSettings(), "capabilities"));
}

async function context() {
  const settings = await getSubmissionSettings();
  const capabilities = capabilitiesSchema.parse(await request(settings, "capabilities"));
  const session = storedSessionSchema.safeParse((await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY]);
  if (!session.success || session.data.revision !== settings.revision || session.data.serverBinding !== capabilities.binding) throw new Error("Session will connect when you apply or discovery runs.");
  return { settings, capabilities, session: session.data };
}

async function sha256(input: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function bindingFor(value: Awaited<ReturnType<typeof context>>): Promise<string> {
  return sha256([value.settings.endpoint, value.settings.revision, value.capabilities.binding, value.session.sessionId].join("|"));
}
export async function submissionBinding(): Promise<string> { return bindingFor(await context()); }

export interface SubmissionStatus { connected:boolean;authenticated:boolean;fillOnly:boolean;binding?:string;error?:string }
class InvalidSubmissionSession extends Error {
  constructor(){super("These WaterlooWorks credentials were rejected. Sign in again before retrying.");}
}
/** Passive dashboard polling never validates, imports, or renews a browser session. */
export async function getSubmissionStatus(): Promise<SubmissionStatus> {
  if (!await hasSubmissionAccess()) return { connected: false, authenticated: false, fillOnly: false };
  let capabilities: SubmissionCapabilities;
  try { capabilities = await submissionCapabilities(); } catch { return { connected: false, authenticated: false, fillOnly: false }; }
  try {
    const value=await context();
    if(capabilities.sessionAvailable===false || (await chrome.storage.session.get(DIRTY_KEY))[DIRTY_KEY])throw new Error("Session will connect when you apply or discovery runs.");
    return { connected: true, authenticated: true, fillOnly: capabilities.fillOnly, binding: await bindingFor(value) };
  } catch(error) { return { connected: true, authenticated: false, fillOnly: capabilities.fillOnly,
    error:error instanceof Error?error.message:"Submission session unavailable" }; }
}

/** Called only for explicit application preparation or scheduled discovery work. */
export async function prepareSubmissionSession():Promise<SubmissionStatus>{
  await ensureSubmissionSession(true);
  return getSubmissionStatus();
}

export async function markSubmissionSessionDirty():Promise<void> {
  await chrome.storage.session.set({[DIRTY_KEY]:crypto.randomUUID()});
}
/** Refresh credentials before dispatch only. Never retries an application command. */
async function ensureSubmissionSession(verify=false):Promise<void> {
  const settings=await getSubmissionSettings();
  await requireSubmissionAccess(settings);
  let current:Awaited<ReturnType<typeof context>>|undefined;
  try {current=await context();}catch{}
  const dirty=Boolean((await chrome.storage.session.get(DIRTY_KEY))[DIRTY_KEY]);
  if(current&&!dirty) {
    if(!verify)return;
    try {
      const live=sessionSchema.parse(await request(current.settings,"session",{headers:{"X-Wat-Session-Id":current.session.sessionId}}));
      if(live.sessionId===current.session.sessionId&&live.accountKey===current.session.accountKey)return;
    }catch{}
  }
  await navigator.locks.request(SETTINGS_LOCK,{mode:"exclusive"},async()=>{
    const latest=await getSubmissionSettings();
    if(latest.revision!==settings.revision)throw new Error("Submission settings changed; prepare again");
    // Another view may already have restored the session while this request waited.
    const stored=storedSessionSchema.safeParse((await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY]);
    if(stored.success&&stored.data.revision===latest.revision&&stored.data.sessionId!==current?.session.sessionId) {
      try {const restored=await context();const live=sessionSchema.parse(await request(latest,"session",{headers:{"X-Wat-Session-Id":restored.session.sessionId}}));if(live.sessionId===restored.session.sessionId&&!(await chrome.storage.session.get(DIRTY_KEY))[DIRTY_KEY])return;}catch{}
    }
    await transferSession();
  });
}

/** Explicit and automatic refresh use the same session import. */
export async function transferSubmissionSession(): Promise<{ accountKey: string }> {
  return settingsWrite(transferSession);
}

async function transferSession():Promise<{accountKey:string}> {
  const settings = await getSubmissionSettings();
  const capabilities = capabilitiesSchema.parse(await request(settings, "capabilities"));
  const {browserResearch}=await import("./research.js");
  if(!(await browserResearch.health()).authenticated)throw new Error("Sign in to WaterlooWorks before transferring your session");
  // The sign-in probe can rotate cookies: capture credentials only after it succeeds.
  const dirtyBefore=(await chrome.storage.session.get(DIRTY_KEY))[DIRTY_KEY];
  const cookies = (await chrome.cookies.getAll({ domain: new URL(WATERLOOWORKS_ORIGIN).hostname })).filter(cookie => cookie.domain.replace(/^\./, "") === new URL(WATERLOOWORKS_ORIGIN).hostname && unexpiredCookie({expires:cookie.expirationDate})).map(cookie => ({
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
    ...(cookie.sameSite === "strict" ? { sameSite: "Strict" } : cookie.sameSite === "lax" ? { sameSite: "Lax" } : cookie.sameSite === "no_restriction" ? { sameSite: "None" } : {}), ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
  })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!cookies.length) throw new Error("Sign in to WaterlooWorks before transferring your session");
  const signature=await sha256(JSON.stringify([settings.revision,capabilities.binding,cookies]));
  if((await chrome.storage.session.get(REJECTED_KEY))[REJECTED_KEY]===signature)throw new InvalidSubmissionSession();
  let session:z.infer<typeof sessionSchema>;
  try {session=sessionSchema.parse(await request(settings, "session", { method: "POST", body: JSON.stringify({ cookies, userAgent: navigator.userAgent }) }));}
  catch(error){if(error instanceof InvalidSubmissionSession)await chrome.storage.session.set({[REJECTED_KEY]:signature});throw error;}
  const current = await getSubmissionSettings();
  if (current.revision !== settings.revision) throw new Error("Submission settings changed during session transfer");
  await chrome.storage.session.set({ [SESSION_KEY]: { ...session, revision: settings.revision, serverBinding: capabilities.binding } });
  await chrome.storage.session.remove(REJECTED_KEY);
  if((await chrome.storage.session.get(DIRTY_KEY))[DIRTY_KEY]===dirtyBefore)await chrome.storage.session.remove(DIRTY_KEY);
  return { accountKey: session.accountKey };
}

export async function callSubmission(method: string, args: unknown[], deadline: number, expectedBinding?: string, onProgress?:(progress:ApplicationProgress)=>void): Promise<unknown> {
  if(expectedBinding===undefined)await ensureSubmissionSession(true);
  return navigator.locks.request(SETTINGS_LOCK, { mode: "shared" }, () => command(method, args, deadline, expectedBinding,onProgress));
}

async function command(method: string, args: unknown[], deadline: number, expectedBinding?: string,onProgress?:(progress:ApplicationProgress)=>void): Promise<unknown> {
  if (!(EXTENSION_METHODS as readonly string[]).includes(method)) throw new Error("Unsupported submission method");
  const encoded = wireEncode({ method, args });
  if (encoded.length > 48_000_000 || !validateExtensionArgs(method as ExtensionMethod, (JSON.parse(encoded) as { args: unknown[] }).args)) throw new Error("Invalid submission arguments");
  const value = await context();
  if (expectedBinding !== undefined && await bindingFor(value) !== expectedBinding) throw new BrowserOperationError({ phase: "preflight", code: "no_remote_mutation", message: "Submission endpoint or session changed; prepare a fresh review" });
  const headers: Record<string, string> = {};
  const mutating = MUTATIONS.has(method);
  if (mutating) {
    if(onProgress)headers.Accept=COMMAND_STREAM_TYPE;
    const attempt = method === "uploadDocument" ? args[4] : (args[0] as { executionAttemptId?: unknown } | undefined)?.executionAttemptId;
    if (typeof attempt !== "string" || !z.string().uuid().safeParse(attempt).success) throw new Error("Approved submission attempt identity is required");
    headers["X-Wat-Command-Id"] = `${attempt}:${method}`;
    headers["X-Wat-Payload-Hash"] = await sha256(encoded);
  }
  try {
    const response = await request(value.settings, "command", { method: "POST", headers, body: wireEncode({ method, args, deadline, binding: value.capabilities.binding, sessionId: value.session.sessionId }) }, deadline,onProgress);
    if (!response || typeof response !== "object") throw new Error("Malformed submission response");
    const result = response as Record<string, unknown>;
    if (typeof result.error === "string") {
      const failure = operationFailureSchema.safeParse(result.failure);
      if (failure.success) throw new BrowserOperationError(failure.data);
      throw new Error(result.error.slice(0, 1000));
    }
    if (!Object.hasOwn(result, "result")) throw new Error("Malformed submission response");
    return wireDecode(result.result);
  } catch (error) {
    if (mutating && !(error instanceof BrowserOperationError)) throw new BrowserOperationError({ phase: "transport", code: "outcome_unknown", message: "Submission request failed; inspect its outcome before retrying" }, error);
    throw error;
  }
}

/** Discovery metadata belongs to the configured server, independently of live browser sessions. */
export async function discoveryRequest(path:string,body?:unknown):Promise<unknown>{
  if(path==="/scan")await ensureSubmissionSession(true);
  const settings=await getSubmissionSettings();
  const send=()=>request(settings,`discovery${path}`,body===undefined?{}:{method:"POST",body:JSON.stringify(body)},Date.now()+180_000);
  return send();
}
