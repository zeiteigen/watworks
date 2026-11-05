import { afterEach, expect, spyOn, test } from "bun:test";
import { WATERLOOWORKS_JOBS_URL } from "../../shared/src/protocol.js";
import { AuthenticationExpiredError, ProtocolChangedError, WaterlooWorksServerError } from "../../waterlooworks-client/src/errors.js";
import { withSignInRecovery } from "./command-auth.js";
import * as submissionClient from "./submission-client.js";
import { executeCommand, methods, reads } from "./commands.js";
import { browserResearch } from "./research.js";
import { clearSignInEpisode, ensureSignIn } from "./signin.js";

const originalChrome = globalThis.chrome;
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  globalThis.chrome = originalChrome;
});

function fixture(existingTab?: number) {
  const session: Record<string, unknown> = {};
  const launches: Array<{ tabId?: number; url: string; active: boolean }> = [];
  let fail = false;
  globalThis.chrome = {
    storage: { session: {
      get: async (key: string) => ({ [key]: session[key] }),
      set: async (value: Record<string, unknown>) => { Object.assign(session, value); },
      remove: async (key: string) => { delete session[key]; },
    } },
    tabs: {
      sendMessage: async () => undefined,
      query: async () => existingTab === undefined ? [] : [{ id: existingTab }],
      create: async (options: { url: string; active: boolean }) => {
        if (fail) throw Error("Browser unavailable");
        return { id: 42 };
      },
      update: async (id: number, options: { url: string; active: boolean }) => {
        if (fail) throw Error("Browser unavailable");
        launches.push({ tabId: id, ...options }); return { id };
      },
    },
  } as unknown as typeof chrome;
  return { session, launches, fail: (value: boolean) => { fail = value; } };
}
const deadline = () => Date.now() + 30_000;

test("MCP status launches login once, then resets after authentication succeeds", async () => {
  const f = fixture();
  const state = { authenticated: false, bridgeConnected: true, bootstrapped: false };
  const health = spyOn(browserResearch, "health").mockImplementation(async () => ({ ...state }));
  restores.push(() => health.mockRestore());
  const results = await Promise.all(Array.from({ length: 5 }, () => executeCommand("health", [], deadline())));
  expect(results).toEqual(Array(5).fill(state));
  expect(f.launches).toEqual([{ tabId: 42, url: WATERLOOWORKS_JOBS_URL, active: true }]);
  state.authenticated = true;
  await executeCommand("health", [], deadline());
  state.authenticated = false;
  await executeCommand("health", [], deadline());
  expect(f.launches).toHaveLength(2);
});

test("research authentication failures reuse the local WaterlooWorks tab without replay", async () => {
  const f = fixture(17), error = new AuthenticationExpiredError();
  const search = spyOn(methods, "searchJobs").mockRejectedValue(error);
  restores.push(() => search.mockRestore());
  await expect(executeCommand("searchJobs", [{}], deadline())).rejects.toBe(error);
  expect(search).toHaveBeenCalledTimes(1);
  expect(f.launches).toEqual([{ tabId:17,url:WATERLOOWORKS_JOBS_URL,active:true }]);
});

test("submission failures are relayed once without opening local sign-in", async () => {
  const f=fixture(17),error=new AuthenticationExpiredError();
  const call=spyOn(submissionClient,"callSubmission").mockRejectedValue(error);
  const account=spyOn(reads,"getAccount");
  restores.push(()=>call.mockRestore(),()=>account.mockRestore());
  const expires=deadline();
  const binding="e".repeat(64);
  await expect(executeCommand("submissionCommand",[binding,"getAccount",[]],expires)).rejects.toBe(error);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith("getAccount",[],expires,binding);
  expect(account).not.toHaveBeenCalled();
  expect(f.launches).toHaveLength(0);
});

test("approved commands carry the pinned endpoint binding and broker deadline",async()=>{
  const call=spyOn(submissionClient,"callSubmission").mockResolvedValue({id:"1"});
  restores.push(()=>call.mockRestore());
  const expires=deadline(),binding="a".repeat(64),args=["123"];
  expect(await executeCommand("submissionCommand",[binding,"getApplicationForm",args],expires)).toEqual({id:"1"});
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith("getApplicationForm",args,expires,binding);
  await expect(executeCommand("submissionCommand",[binding,"searchJobs",[]],expires)).rejects.toThrow("Unsupported");
});

test("opaque SSO redirects from the real browser fetch launch login through wrapped errors", async () => {
  const f = fixture();
  const response = new Response(null);
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(response);
  restores.push(() => fetch.mockRestore());
  await expect(executeCommand("bootstrap", [], deadline())).rejects.toThrow("request failed");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(f.launches).toHaveLength(1);
});

test("protocol failures and server outages do not trigger authentication recovery or retries", async () => {
  const f = fixture();
  for (const error of [new ProtocolChangedError("Changed page"), new WaterlooWorksServerError("Unavailable")]) {
    let attempts = 0;
    await expect(withSignInRecovery("submitApplication", async () => { attempts++; throw error; })).rejects.toBe(error);
    expect(attempts).toBe(1);
  }
  expect(f.launches).toHaveLength(0);
});

test("failed tab launches can retry, while the original operation failure is preserved", async () => {
  const f = fixture();
  f.fail(true);
  const error = new AuthenticationExpiredError();
  await expect(withSignInRecovery("uploadDocument", async () => { throw error; })).rejects.toBe(error);
  expect(f.session["signin:episode-opened"]).toBeUndefined();
  f.fail(false);
  await ensureSignIn();
  expect(f.launches).toHaveLength(1);
  await clearSignInEpisode();
});

test("a failed status tab launch still reports authentication state", async () => {
  const f = fixture();
  f.fail(true);
  const state = { authenticated: false, bridgeConnected: true, bootstrapped: false };
  const health = spyOn(browserResearch, "health").mockResolvedValue(state);
  restores.push(() => health.mockRestore());
  expect(await executeCommand("health", [], deadline())).toEqual(state);
  expect(f.session["signin:episode-opened"]).toBeUndefined();
});

test("expired commands and noninteractive discovery do not open browser tabs", async () => {
  const f = fixture();
  const search = spyOn(methods, "searchJobs").mockRejectedValue(new AuthenticationExpiredError());
  restores.push(() => search.mockRestore());
  await expect(executeCommand("searchJobs", [{}], 1)).rejects.toThrow("expired");
  await ensureSignIn(false);
  expect(search).not.toHaveBeenCalled();
  expect(f.launches).toHaveLength(0);
});


test("application inventory uses the local browser even when the submission server fails",async()=>{
  fixture();
  const inventory={accountKey:"local-account",checkedAt:new Date().toISOString(),termId:"437",applications:[]};
  const local=spyOn(reads,"listApplications").mockResolvedValue(inventory);
  const remote=spyOn(submissionClient,"callSubmission").mockRejectedValue(new Error("Submission server returned HTTP 400"));
  restores.push(()=>local.mockRestore(),()=>remote.mockRestore());
  expect(await executeCommand("listApplications",[],deadline())).toEqual(inventory);
  expect(await methods.listApplications!()).toEqual(inventory);
  expect(remote).not.toHaveBeenCalled();
});

test("approved submission verification still uses its server's isolated inventory",async()=>{
  fixture();
  const inventory={accountKey:"server-account",checkedAt:new Date().toISOString(),termId:"437",applications:[]};
  const remote=spyOn(submissionClient,"callSubmission").mockResolvedValue(inventory);
  const local=spyOn(reads,"listApplications");
  restores.push(()=>local.mockRestore(),()=>remote.mockRestore());
  const expires=deadline(),binding="d".repeat(64);
  expect(await executeCommand("submissionCommand",[binding,"listApplications",[]],expires)).toEqual(inventory);
  expect(remote).toHaveBeenCalledWith("listApplications",[],expires,binding);
  expect(local).not.toHaveBeenCalled();
});


test("local reconciliation reads never contact the submission server or refresh its credentials",async()=>{
  fixture();
  const account=spyOn(reads,"getAccount").mockResolvedValue({accountKey:"local",accountLabel:"Student"});
  const status=spyOn(reads,"getApplicationStatus").mockResolvedValue({jobId:"495376",hasApplication:true});
  const remote=spyOn(submissionClient,"callSubmission").mockRejectedValue(new Error("Submission server returned HTTP 400"));
  restores.push(()=>account.mockRestore(),()=>status.mockRestore(),()=>remote.mockRestore());
  expect(await executeCommand("localApplicationRead",["getAccount",[]],deadline())).toMatchObject({accountKey:"local"});
  expect(await executeCommand("localApplicationRead",["getApplicationStatus",["495376"]],deadline())).toEqual({jobId:"495376",hasApplication:true});
  await expect(executeCommand("localApplicationRead",["submitApplication",[]],deadline())).rejects.toThrow("Unsupported");
  await expect(executeCommand("localApplicationRead",["getApplicationStatus",[]],deadline())).rejects.toThrow("Unsupported");
  expect(remote).not.toHaveBeenCalled();
});

for(const [method,args] of [
  ["getAccount",[]],
  ["getApplicationForm",["495297"]],
  ["getApplicationStatus",["495297"]],
  ["listApplications",[]],
  ["listDocuments",[]],
  ["getDocument",["123"]],
  ["getDocumentSnapshot",["123"]],
] as const){
  test(`${method} preparation works locally while the submission service is unavailable`,async()=>{
    fixture();
    const value={route:"local"};
    const local=spyOn(reads,method).mockImplementation(async()=>value as never);
    const remote=spyOn(submissionClient,"callSubmission").mockRejectedValue(new Error("Browser quota exhausted"));
    restores.push(()=>local.mockRestore(),()=>remote.mockRestore());
    expect(await executeCommand(method,[...args],deadline())).toEqual(value);
    expect(await methods[method]!(...args)).toEqual(value);
    expect(local).toHaveBeenCalledTimes(2);
    expect(local).toHaveBeenCalledWith(...args);
    expect(remote).not.toHaveBeenCalled();
  });
  test(`pinned ${method} validation stays remote and never falls back to local reads`,async()=>{
    fixture();
    const error=new Error("Browser quota exhausted");
    const local=spyOn(reads,method);
    const remote=spyOn(submissionClient,"callSubmission").mockRejectedValue(error);
    restores.push(()=>local.mockRestore(),()=>remote.mockRestore());
    const expires=deadline(),binding="b".repeat(64);
    await expect(executeCommand("submissionCommand",[binding,method,[...args]],expires)).rejects.toBe(error);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote).toHaveBeenCalledWith(method,[...args],expires,binding);
    expect(local).not.toHaveBeenCalled();
  });
}

test("preparation authentication failures open local sign-in without contacting the server",async()=>{
  const f=fixture(17),error=new AuthenticationExpiredError();
  const local=spyOn(reads,"getApplicationForm").mockRejectedValue(error);
  const remote=spyOn(submissionClient,"callSubmission");
  restores.push(()=>local.mockRestore(),()=>remote.mockRestore());
  await expect(executeCommand("getApplicationForm",["495297"],deadline())).rejects.toBe(error);
  expect(local).toHaveBeenCalledTimes(1);
  expect(remote).not.toHaveBeenCalled();
  expect(f.launches).toEqual([{tabId:17,url:WATERLOOWORKS_JOBS_URL,active:true}]);
});
