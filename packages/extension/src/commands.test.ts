import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { WATERLOOWORKS_JOBS_URL } from "../../shared/src/protocol.js";
import { AuthenticationExpiredError, ProtocolChangedError, WaterlooWorksServerError } from "../../waterlooworks-client/src/errors.js";
import { withSignInRecovery } from "./command-auth.js";
import * as submissionClient from "./submission-client.js";
import { executeCommand, methods, reads } from "./commands.js";
import { browserResearch } from "./research.js";
import { mintWriteApproval, verifyWriteApproval } from "./write-approval.js";
import { BrowserOperationError } from "../../shared/src/operation-failure.js";
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
      setAccessLevel: async () => {},
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

test("MCP status stays passive across repeated checks and session expiry", async () => {
  const f = fixture();
  const state = { authenticated: false, bridgeConnected: true, bootstrapped: false };
  const health = spyOn(browserResearch, "health").mockImplementation(async () => ({ ...state }));
  restores.push(() => health.mockRestore());
  const results = await Promise.all(Array.from({ length: 5 }, () => executeCommand("health", [], deadline())));
  expect(results).toEqual(Array(5).fill(state));
  expect(f.launches).toHaveLength(0);
  state.authenticated = true;
  await executeCommand("health", [], deadline());
  state.authenticated = false;
  await executeCommand("health", [], deadline());
  expect(f.launches).toHaveLength(0);
  expect(f.session["signin:episode-opened"]).toBeUndefined();
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

test("status reports authentication state even when browser tabs are unavailable", async () => {
  const f = fixture();
  f.fail(true);
  const state = { authenticated: false, bridgeConnected: true, bootstrapped: false };
  const health = spyOn(browserResearch, "health").mockResolvedValue(state);
  restores.push(() => health.mockRestore());
  expect(await executeCommand("health", [], deadline())).toEqual(state);
  expect(f.launches).toHaveLength(0);
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

test("background reconciliation authentication failures never open login or replay reads",async()=>{
  const f=fixture(),error=new AuthenticationExpiredError();
  const local=spyOn(reads,"listApplications").mockRejectedValue(error);
  restores.push(()=>local.mockRestore());
  for(let check=0;check<3;check++){
    await expect(executeCommand("localApplicationRead",["listApplications",[]],deadline())).rejects.toBe(error);
  }
  await expect(methods.localApplicationRead!("listApplications",[])).rejects.toBe(error);
  expect(local).toHaveBeenCalledTimes(4);
  expect(f.launches).toHaveLength(0);
  expect(f.session["signin:episode-opened"]).toBeUndefined();
});

describe("write approvals in executeCommand", () => {
  const manifest = (jobId = "123") => ({ kind: "application", jobId, executionAttemptId: crypto.randomUUID() });
  const binding = "a".repeat(64);
  const spy = () => {
    const call = spyOn(submissionClient, "callSubmission").mockResolvedValue({ ok: true });
    restores.push(() => call.mockRestore());
    return call;
  };
  const refused = async (run: Promise<unknown>) => {
    const error = await run.then(() => undefined, failure => failure);
    expect(error).toBeInstanceOf(BrowserOperationError);
    expect((error as BrowserOperationError).failure.code).toBe("no_remote_mutation");
  };
  const mint = async (jobId = "123") => (await mintWriteApproval("apply", `waterlooworks:${jobId}`)).token;

  test.each(["submitApplication", "fillApplication", "stageAttachments"])("a forged %s is refused, direct and pinned, without or with a guessed token", async method => {
    fixture();
    const call = spy();
    for (const token of [undefined, "g".repeat(43)]) {
      await refused(executeCommand(method, [manifest(), [], []], deadline(), undefined, token));
      await refused(executeCommand("submissionCommand", [binding, method, [manifest(), [], []]], deadline(), undefined, token));
    }
    expect(call).not.toHaveBeenCalled();
  });

  test("a forged upload is refused and default changes are refused even with a valid approval", async () => {
    fixture();
    const call = spy();
    await refused(executeCommand("uploadDocument", ["1", "name", {}, "account", crypto.randomUUID()], deadline()));
    await refused(executeCommand("setDefaultDocuments", ["1", ["2"], "account"], deadline(), undefined, await mint()));
    await refused(executeCommand("submissionCommand", [binding, "setDefaultDocuments", ["1", ["2"], "account"]], deadline(), undefined, await mint()));
    expect(call).not.toHaveBeenCalled();
  });

  test("a token for another job, another action, or an expired click is refused", async () => {
    fixture();
    const call = spy();
    await refused(executeCommand("submitApplication", [manifest("999"), []], deadline(), undefined, await mint("123")));
    const recover = (await mintWriteApproval("recover", "waterlooworks:123")).token;
    await refused(executeCommand("submitApplication", [manifest(), []], deadline(), undefined, recover));
    await refused(executeCommand("uploadDocument", ["1", "name", {}, "account", crypto.randomUUID()], deadline(), undefined, recover));
    const clock = Date.now, expired = await mint();
    try {
      Date.now = () => clock() + 15 * 60_000 + 1;
      await refused(executeCommand("submitApplication", [manifest(), []], deadline(), undefined, expired));
    } finally { Date.now = clock; }
    expect(call).not.toHaveBeenCalled();
  });

  test("one click covers upload, staging and one submission, then is spent", async () => {
    fixture();
    const call = spy();
    const token = await mint();
    const upload = () => executeCommand("uploadDocument", ["1", "name", {}, "account", crypto.randomUUID()], deadline(), undefined, token);
    await upload();
    await executeCommand("submissionCommand", [binding, "stageAttachments", [manifest(), []]], deadline(), undefined, token);
    await refused(executeCommand("stageAttachments", [manifest(), []], deadline(), undefined, token));
    await upload();
    await refused(upload());
    expect((await verifyWriteApproval(token, "apply", "waterlooworks:123")).valid).toBe(true);
    await executeCommand("submissionCommand", [binding, "submitApplication", [manifest(), [], []]], deadline(), undefined, token);
    expect(call).toHaveBeenCalledTimes(4);
    expect((await verifyWriteApproval(token, "apply", "waterlooworks:123")).valid).toBe(false);
    await refused(executeCommand("submitApplication", [manifest(), []], deadline(), undefined, token));
    await refused(executeCommand("fillApplication", [manifest(), [], []], deadline(), undefined, token));
    expect(call).toHaveBeenCalledTimes(4);
  });

  test("the approval survives a service-worker restart because only session storage holds it", async () => {
    const f = fixture();
    const token = await mint();
    expect(JSON.stringify(f.session)).not.toContain(token);
    const fresh = await import(`./write-approval.js?restart=${Math.random()}`) as typeof import("./write-approval.js");
    expect((await fresh.verifyWriteApproval(token, "apply", "waterlooworks:123")).valid).toBe(true);
    expect((await fresh.verifyWriteApproval(token, "apply", "waterlooworks:456")).valid).toBe(false);
    expect((await fresh.verifyWriteApproval(token, "recover", "waterlooworks:123")).valid).toBe(false);
  });

  test("verification is exposed as a read-only command that never contacts the server", async () => {
    fixture();
    const call = spy();
    const token = await mint();
    expect(await executeCommand("verifyWriteApproval", [token, "apply", "waterlooworks:123"], deadline())).toEqual({ valid: true });
    expect(await executeCommand("verifyWriteApproval", [token, "apply", "waterlooworks:123"], deadline())).toEqual({ valid: true });
    expect(call).not.toHaveBeenCalled();
  });

  test("minting refuses unknown actions and malformed targets", async () => {
    fixture();
    await expect(mintWriteApproval("confirm", "waterlooworks:123")).rejects.toThrow("Invalid");
    await expect(mintWriteApproval("apply", "../etc")).rejects.toThrow("Invalid");
    await expect(mintWriteApproval("release", "bad id")).rejects.toThrow("Invalid");
    expect((await mintWriteApproval("release", "attempt-1")).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("direct method handlers can never run a write", async () => {
    fixture();
    const call = spy();
    await expect(methods.submitApplication!({}, [])).rejects.toThrow("approved command");
    await expect(methods.submissionCommand!(binding, "uploadDocument", [])).rejects.toThrow("approved command");
    expect(call).not.toHaveBeenCalled();
  });
});
