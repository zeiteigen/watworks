import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BrowserOperationError } from "../../shared/src/operation-failure.js";
import { callSubmission, discoveryRequest, getSubmissionStatus, prepareSubmissionSession, saveSubmissionSettings, submissionBinding, transferSubmissionSession, markSubmissionSessionDirty, getSubmissionSettings, validateSubmissionEndpoint, validateSubmissionHeaders } from "./submission-client.js";
import { browserResearch } from "./research.js";
import { refreshDueDiscovery } from "./discovery-session.js";
import { currentWaterlooWorksSession } from "./waterlooworks-session.js";
import { INSIDER_SESSION_KEY } from "./insider-session.js";
import { wireEncode } from "./wire.js";
import { commandStream, COMMAND_STREAM_TYPE } from "../../shared/src/command-stream.js";
import type { ApplicationProgress } from "../../shared/src/application-progress.js";

const savedFetch = globalThis.fetch;
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
let requests: Array<{ url: string; init: RequestInit }>;
let cookies: unknown[];
let sessions: Map<string, unknown>;
let commandResult: () => Promise<Response>;
let locksHeld = 0;
let deleteUnavailable = false;
let sessionExpired=false,serverBinding="server-binding";
let remoteSessionAvailable=false;
let researchHealth: {authenticated:boolean;bridgeConnected:boolean;bootstrapped:boolean;error?:string};
let healthSpy: ReturnType<typeof spyOn>;
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const session = { accountKey: "student-123", sessionId: "opaque-session-123" };

beforeEach(() => {
  requests = []; cookies = []; sessions = new Map(); locksHeld = 0; deleteUnavailable = false; sessionExpired=false;serverBinding="server-binding";remoteSessionAvailable=false;
  researchHealth={authenticated:true,bridgeConnected:true,bootstrapped:true};
  healthSpy=spyOn(browserResearch,"health").mockImplementation(async()=>({...researchHealth}));
  commandResult = async () => response({ result: { success: true } });
  const storage = (values: Map<string, unknown>) => ({
    get: async (key: string) => ({ [key]: values.get(key) }),
    set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value)); },
    remove: async (key: string) => { values.delete(key); }, setAccessLevel: async () => undefined,
  });
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: storage(new Map()), session: storage(sessions) }, cookies: { getAll: async () => cookies } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    userAgent: "Browser/Test", locks: { request: async (_key: string, options: { mode: string; ifAvailable?: boolean }, task: (lock: object | null) => Promise<unknown>) => {
      if (options.ifAvailable && locksHeld) return task(null);
      locksHeld++; try { return await task({}); } finally { locksHeld--; }
    } },
  } });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith("/capabilities")) return response({ version: 1, binding: serverBinding, fillOnly: false, sessionAvailable:remoteSessionAvailable });
    if (url.endsWith("/session")) {
      if (init.method === "DELETE" && deleteUnavailable) throw new Error("Offline; credentials must not appear in diagnostics");
      if(init.method === "POST"){sessionExpired=false;remoteSessionAvailable=true;}
      if(init.method !== "POST" && init.method !== "DELETE" && sessionExpired)return new Response(null,{status:409});
      return response(init.method === "DELETE" ? { ok: true } : session);
    }
    if (url.endsWith("/command")) return commandResult();
    throw new Error("Unexpected URL");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  healthSpy.mockRestore();
  if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator); else Reflect.deleteProperty(globalThis, "navigator");
  if (savedChrome) Object.defineProperty(globalThis, "chrome", savedChrome); else Reflect.deleteProperty(globalThis, "chrome");
});

async function verifiedInsider() {
  const settings = await getSubmissionSettings();
  sessions.set(INSIDER_SESSION_KEY, {...settings, email: "student@uwaterloo.ca", token: "f".repeat(64), expiresAt: Date.now()+3600000, fingerprint: (await currentWaterlooWorksSession()).fingerprint});
}

async function connected() {
  await saveSubmissionSettings("https://submit.example.test/team", { Authorization: "Bearer proxy-token" });
  cookies = [{ name: "sid", value: "session-cookie", domain: "waterlooworks.uwaterloo.ca", path: "/", secure: true, httpOnly: true, sameSite: "strict" }];
  await verifiedInsider();
  await transferSubmissionSession();
}

describe("submission endpoint trust boundary", () => {
  test("custom proxy authorization supports self-hosting without an Insider token", async () => {
    await saveSubmissionSettings("https://submit.example.test/team", {Authorization:"Bearer proxy-token"});
    cookies = [{name:"sid",value:"session-cookie",domain:"waterlooworks.uwaterloo.ca",path:"/",secure:true,httpOnly:true}];
    await transferSubmissionSession();
    expect(requests.some(item => item.url.endsWith('/auth/waterlooworks'))).toBe(false);
    const imported = requests.find(item => item.url.endsWith('/session') && item.init.method === 'POST')!;
    expect(imported.init.headers).toMatchObject({authorization:'Bearer proxy-token'});
  });
  test("uses Cloudflare without transferring credentials during settings reads and preserves saved overrides", async () => {
    expect(await getSubmissionSettings()).toMatchObject({endpoint:"https://watworks.alishahzad.dev",headers:{}});
    expect(requests).toHaveLength(0);
    await saveSubmissionSettings("http://127.0.0.1:39453",{});
    expect((await getSubmissionSettings()).endpoint).toBe("http://127.0.0.1:39453");
  });
  test("requires HTTPS or literal loopback and rejects URL credentials", () => {
    for (const input of ["http://remote.test", "file:///tmp/server", "https://user:password@remote.test", "https://remote.test?q=secret", "https://remote.test/#secret", "http://127.0.0.1.evil.test"]) expect(() => validateSubmissionEndpoint(input)).toThrow();
    expect(validateSubmissionEndpoint("https://submit.test/prefix/")).toBe("https://submit.test/prefix");
    expect(validateSubmissionEndpoint("http://[::1]:39453/")).toBe("http://[::1]:39453");
  });
  test("protects proxy identity and transport headers", () => {
    for (const header of ["X-Wat-User-Id", "x-Wat-Command-id", "X-Submission-User", "X-Forwarded-User", "Remote-User", "Cookie", "Host", "Origin", "Content-Type", "User-Agent", "Sec-Fetch-Site"]) expect(() => validateSubmissionHeaders({ [header]: "value" })).toThrow();
    expect(() => validateSubmissionHeaders({ Authorization: "a\r\nX-Wat-User-Id: victim" })).toThrow();
    expect(() => validateSubmissionHeaders({ Authorization: "a", authorization: "b" })).toThrow();
    expect(validateSubmissionHeaders({ Authorization: "Bearer token", "CF-Access-Client-Id": "client" })).toEqual({ authorization: "Bearer token", "cf-access-client-id": "client" });
  });
  test("cookies transfer only explicitly to configured endpoint with no redirect or ambient credentials", async () => {
    await saveSubmissionSettings("https://submit.example.test/team", {});
    expect(requests).toHaveLength(0);
    cookies = [
      { name: "expired", value: "expired-secret", domain: "waterlooworks.uwaterloo.ca", path: "/", secure: true, httpOnly: true, expirationDate: 1 },
      { name: "sid", value: "secret", domain: ".waterlooworks.uwaterloo.ca", path: "/myAccount", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: 2000000000 },
      { name: "other", value: "blocked", domain: "login.microsoftonline.com", path: "/", secure: true, httpOnly: true, sameSite: "lax" },
    ];
    await verifiedInsider();
    await transferSubmissionSession();
    const sent = requests.find(item => item.init.method === "POST")!;
    expect(sent.url).toBe("https://submit.example.test/team/v1/session");
    expect(JSON.parse(sent.init.body as string)).toEqual({ userAgent: "Browser/Test", cookies: [{ name: "sid", value: "secret", domain: ".waterlooworks.uwaterloo.ca", path: "/myAccount", secure: true, httpOnly: true, sameSite: "None", expires: 2000000000 }] });
    expect(sent.init.redirect).toBe("error"); expect(sent.init.credentials).toBe("omit");
    expect(JSON.stringify([...sessions.values()])).not.toContain("secret");
    expect(await getSubmissionStatus()).toMatchObject({ connected: true, authenticated: true, fillOnly: false });
  });
  test("rejects mutation without reviewed identity and changed binding before sending command", async () => {
    await connected();
    await expect(callSubmission("submitApplication", [{}, []], Date.now() + 30000)).rejects.toThrow("attempt identity");
    await expect(callSubmission("getAccount", [], Date.now() + 30000, "old-binding")).rejects.toBeInstanceOf(BrowserOperationError);
    expect(requests.filter(item => item.url.endsWith("/command"))).toHaveLength(0);
  });
  test("binds mutation id and hash to wire encoded method and args", async () => {
    await connected();
    const attempt = crypto.randomUUID();
    const args = [{ executionAttemptId: attempt }, []];
    await callSubmission("submitApplication", args, Date.now() + 30000, await submissionBinding());
    const sent = requests.find(item => item.url.endsWith("/command"))!;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(wireEncode({ method: "submitApplication", args })))), byte => byte.toString(16).padStart(2, "0")).join("");
    expect(sent.init.headers).toMatchObject({ "X-Wat-Command-Id": `${attempt}:submitApplication`, "X-Wat-Payload-Hash": hash, authorization: `Bearer ${"f".repeat(64)}` });
    expect(JSON.parse(sent.init.body as string)).toMatchObject({ binding: "server-binding", sessionId: session.sessionId });
  });
  test("blocks endpoint/session edits throughout an active command", async () => {
    await connected();
    let finish!: (value: Response) => void;
    commandResult = () => new Promise(resolve => { finish = resolve; });
    const active = callSubmission("getAccount", [], Date.now() + 30000);
    while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
    await expect(saveSubmissionSettings("https://another.test", {})).rejects.toThrow("active");
    await expect(transferSubmissionSession()).rejects.toThrow("active");
    finish(response({ result: { accountKey: "student-123" } })); await active;
  });
  test("failed mutation has unknown outcome without retry", async () => {
    await connected(); commandResult = async () => { throw new TypeError("Network failed"); };
    const attempt = crypto.randomUUID();
    try { await callSubmission("submitApplication", [{ executionAttemptId: attempt }, []], Date.now() + 30000); throw new Error("Expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(BrowserOperationError); expect((error as BrowserOperationError).failure.code).toBe("outcome_unknown"); }
    expect(requests.filter(item => item.url.endsWith("/command"))).toHaveLength(1);
  });
  test("changing saved endpoint invalidates the imported session", async () => {
    await connected(); await saveSubmissionSettings("https://new.test", {});
    expect((await getSubmissionStatus()).authenticated).toBe(false);
    expect(requests.find(item => item.init.method === "DELETE")?.url).toBe("https://submit.example.test/team/v1/session");
  });
  test("offline previous server does not block endpoint replacement and returns a sanitized warning", async () => {
    await connected(); deleteUnavailable = true;
    const saved = await saveSubmissionSettings("https://new.test", {});
    expect(saved.warning).toContain("could not confirm session removal");
    expect(saved.warning).not.toContain("credentials");
    expect((await getSubmissionStatus()).authenticated).toBe(false);
  });
});


async function configured() {
  await saveSubmissionSettings("http://127.0.0.1:39453",{});
  cookies=[{name:"sid",value:"cookie-secret",domain:"waterlooworks.uwaterloo.ca",path:"/",secure:true,httpOnly:true,sameSite:"lax"}];
}
for (const legacyChoice of [undefined, false, true]) {
  test(`session sharing is automatic regardless of legacy consent (${legacyChoice})`, async () => {
    await configured();
    if (legacyChoice !== undefined) await chrome.storage.local.set({"submission:automatic-transfer-consent": {revision: (await getSubmissionSettings()).revision, allowed: legacyChoice}});
    expect(await getSubmissionStatus()).toMatchObject({authenticated:false});
    expect(requests.some(r => r.init.method === "POST")).toBe(false);
    await prepareSubmissionSession();
    expect(await getSubmissionStatus()).toMatchObject({authenticated:true});
    expect(requests.filter(r => r.url.endsWith("/session") && r.init.method === "POST")).toHaveLength(1);
  });
}
test("status is passive; demand preparation restores after browser or server restart",async()=>{
  await configured();await prepareSubmissionSession();
  expect((await getSubmissionStatus()).authenticated).toBe(true);
  sessions.clear();
  const before=requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST").length;
  expect((await getSubmissionStatus()).authenticated).toBe(false);
  expect(requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST")).toHaveLength(before);
  await prepareSubmissionSession();
  serverBinding="restarted-server";
  expect((await getSubmissionStatus()).authenticated).toBe(false);
  await prepareSubmissionSession();
  expect((await getSubmissionStatus()).authenticated).toBe(true);
  expect(requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST")).toHaveLength(before+2);
});
test("expired server sessions refresh on demand without resubmitting",async()=>{
  await configured();await prepareSubmissionSession();sessionExpired=true;
  expect((await getSubmissionStatus()).authenticated).toBe(true);
  const before=requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST").length;
  expect((await getSubmissionStatus()).authenticated).toBe(true);
  expect(requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST")).toHaveLength(before);
  await prepareSubmissionSession();
  expect((await getSubmissionStatus()).authenticated).toBe(true);
  expect(requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST")).toHaveLength(2);
  expect(requests.some(r=>r.url.endsWith("/command"))).toBe(false);
});
test("cookie changes refresh the session before the next unpinned read",async()=>{
  await configured();await prepareSubmissionSession();
  await markSubmissionSessionDirty();
  await callSubmission("getAccount",[],Date.now()+30_000);
  expect(requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST")).toHaveLength(2);
  expect(requests.filter(r=>r.url.endsWith("/command"))).toHaveLength(1);
});
test("changing endpoint imports a fresh session on demand without a prompt",async()=>{
  await configured();await prepareSubmissionSession();
  await saveSubmissionSettings("http://127.0.0.1:39454",{});
  expect(await getSubmissionStatus()).toMatchObject({authenticated:false});
  await prepareSubmissionSession();
  expect(await getSubmissionStatus()).toMatchObject({authenticated:true});
  expect(requests.filter(r=>r.url==="http://127.0.0.1:39454/v1/session"&&r.init.method==="POST")).toHaveLength(1);
});
test("approved operations do not silently import a replacement session",async()=>{
  await configured();await prepareSubmissionSession();const binding=await submissionBinding();
  sessions.clear();const before=requests.filter(r=>r.init.method==="POST").length;
  await expect(callSubmission("submitApplication",[{executionAttemptId:crypto.randomUUID()},[]],Date.now()+30_000,binding)).rejects.toThrow();
  expect(requests.filter(r=>r.init.method==="POST")).toHaveLength(before);
});
test("automatic transfer is used before a read but network failure never replays a write",async()=>{
  await configured();
  commandResult=async()=>{throw new Error("Network failed");};
  await expect(callSubmission("submitApplication",[{executionAttemptId:crypto.randomUUID()},[]],Date.now()+30_000)).rejects.toBeInstanceOf(BrowserOperationError);
  expect(requests.filter(r=>r.url.endsWith("/command"))).toHaveLength(1);
});


test("browser startup failure reports the server problem without a misleading sign-in request",async()=>{
  await configured();
  const previous=globalThis.fetch;
  let imports=0;
  globalThis.fetch=(async(input,init)=>String(input).endsWith("/session")&&init?.method==="POST"
    ?(imports++,new Response(JSON.stringify({code:"browser_unavailable",error:"private server output"}),{status:503,headers:{"content-type":"application/json"}}))
    :previous(input,init)) as typeof fetch;
  await expect(prepareSubmissionSession()).rejects.toThrow("Submission browser could not start");
  expect(imports).toBe(1);
});

for(const [code,expected] of [
  ["browser_rate_limited","Cloudflare Browser Run refused browser startup (HTTP 429)"],
  ["browser_quota_exceeded","daily browser-time quota is exhausted"],
] as const){
  test(`preparation reports ${code} without replaying the import`,async()=>{
    await configured();
    const previous=globalThis.fetch;
    let imports=0;
    globalThis.fetch=(async(input,init)=>String(input).endsWith("/session")&&init?.method==="POST"
      ?(imports++,Response.json({code,error:"private server output"},{status:503}))
      :previous(input,init)) as typeof fetch;
    await expect(prepareSubmissionSession()).rejects.toThrow(expected);
    expect(imports).toBe(1);
  });
}

test("unauthenticated browser health prevents cookie export",async()=>{
  await configured();researchHealth={authenticated:false,bridgeConnected:true,bootstrapped:false,error:"WaterlooWorks sign-in required"};
  await expect(prepareSubmissionSession()).rejects.toThrow(/sign in|authenticated/i);
  expect(requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST")).toHaveLength(0);
});

test("failed cookie import is cached until the browser cookies change",async()=>{
  await configured();
  const previous=globalThis.fetch;
  let imports=0;
  globalThis.fetch=(async(input,init)=>{
    if(String(input).endsWith("/session")&&init?.method==="POST"){
      imports++;
      const body=JSON.parse(String(init.body));
      if(body.cookies.some((cookie:{value:string})=>cookie.value==="cookie-secret"))return new Response(JSON.stringify({code:"session_invalid",error:"rejected"}),{status:400,headers:{"content-type":"application/json"}});
    }
    return previous(input,init);
  }) as typeof fetch;
  await expect(prepareSubmissionSession()).rejects.toThrow(/reject|sign in|session/i);
  await expect(prepareSubmissionSession()).rejects.toThrow(/reject|sign in|session/i);
  expect(imports).toBe(1);
  cookies=[{name:"sid",value:"new-cookie",domain:"waterlooworks.uwaterloo.ca",path:"/",secure:true,httpOnly:true,sameSite:"lax"}];
  await prepareSubmissionSession();
  expect(imports).toBe(2);
});

test("failed discovery metadata reads never trigger a session import",async()=>{
  await saveSubmissionSettings("http://127.0.0.1:39453",{});
  await expect(discoveryRequest("")).rejects.toThrow();
  expect(requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST")).toHaveLength(0);
  expect(healthSpy).not.toHaveBeenCalled();
});

test("due discovery refresh shares a session only when the server says a scan is due",async()=>{
  const previous=globalThis.fetch;
  let due=false,scans=0;
  globalThis.fetch=(async(input,init)=>{
    const url=String(input);
    if(url.endsWith("/discovery")&&init?.method!="POST")return response({due});
    if(url.endsWith("/discovery/scan")){scans++;return response({added:0,errors:0});}
    return previous(input,init);
  }) as typeof fetch;
  await configured();
  await refreshDueDiscovery();
  expect(healthSpy).not.toHaveBeenCalled();
  expect(requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST")).toHaveLength(0);
  due=true;
  await refreshDueDiscovery();
  expect(scans).toBe(1);
  expect(requests.filter(r=>r.url.endsWith("/session")&&r.init.method==="POST")).toHaveLength(1);
});

test("the existing approved command request streams progress before its terminal result",async()=>{
  await connected();
  const binding=await submissionBinding();
  let emit:((progress:ApplicationProgress)=>void)|undefined,finish:((value:string)=>void)|undefined;
  commandResult=async()=>commandStream(()=>new Promise(resolve=>{finish=resolve;}),listener=>{emit=listener;return ()=>{};});
  const received:ApplicationProgress[]=[];
  const pending=callSubmission("submitApplication",[{executionAttemptId:crypto.randomUUID()},[]],Date.now()+30_000,binding,value=>received.push(value));
  while(!finish || !emit)await Bun.sleep(1);
  emit({phase:"submitting"});
  for(let i=0;i<20;i++)await Promise.resolve();
  expect(received).toEqual([{phase:"submitting"}]);
  const sent=requests.filter(request=>request.url.endsWith("/command"));
  expect(sent).toHaveLength(1);expect(new Headers(sent[0]!.init.headers).get("accept")).toBe(COMMAND_STREAM_TYPE);
  finish(wireEncode({result:{status:"submitted",bytes:Uint8Array.of(1,2,255)}}));
  expect(await pending).toEqual({status:"submitted",bytes:Uint8Array.of(1,2,255)});
});

test("an interrupted command stream reports an unknown outcome without replaying the mutation",async()=>{
  await connected();
  commandResult=async()=>new Response('{"progress":{"phase":"submitting"}}\n',{headers:{"content-type":COMMAND_STREAM_TYPE}});
  try{
    await callSubmission("submitApplication",[{executionAttemptId:crypto.randomUUID()},[]],Date.now()+30_000,await submissionBinding());
    throw new Error("Expected interruption");
  }catch(error){expect(error).toBeInstanceOf(BrowserOperationError);expect((error as BrowserOperationError).failure.code).toBe("outcome_unknown");}
  expect(requests.filter(request=>request.url.endsWith("/command"))).toHaveLength(1);
});

for (const invalidation of ["free", "expired", "changed-account"] as const) {
  test(`${invalidation} hosted account is not probed by passive polling`, async () => {
    if (invalidation !== "free") {
      await verifiedInsider();
      if (invalidation === "expired") (sessions.get(INSIDER_SESSION_KEY) as {expiresAt:number}).expiresAt = 1;
      if (invalidation === "changed-account") cookies = [{name:"sid",value:"another-account",domain:"waterlooworks.uwaterloo.ca",path:"/",secure:true,httpOnly:true}];
    }
    expect(await getSubmissionStatus()).toMatchObject({connected:false, authenticated:false});
    await refreshDueDiscovery();
    expect(requests).toEqual([]);
    expect(healthSpy).not.toHaveBeenCalled();
  });
}
