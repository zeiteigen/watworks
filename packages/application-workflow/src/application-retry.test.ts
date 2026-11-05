import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttemptLedger } from "./ledger.js";
import { authorizeApplicationRetry } from "./application-retry.js";
import { fingerprint } from "./fingerprint.js";
import type { ApplicationGateway, ApplicationForm, ApplicationInventory } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wat-application-retry-"));
  const path = join(root, "ledger.sqlite");
  const ledger = new AttemptLedger(path);
  cleanup.push(async () => { ledger.close(); await rm(root, {recursive:true,force:true}); });
  const accountKey = "a".repeat(64), jobId = "494987", term = "2027 - Winter";
  const operationKey = fingerprint(["application",accountKey,jobId,term]);
  const clock = Date.now;
  try {
    Date.now = () => clock() - 180_000;
    ledger.reserve({attemptId:"old",accountKey,operationKey,manifestHash:"b".repeat(64),kind:"application"});
    ledger.transition("old","staging"); ledger.transition("old","outcome_unknown");
  } finally { Date.now = clock; }
  const form = {accountKey,jobId,term,hasApplication:false,canApply:true,blockers:[],deadline:"2099-01-01T00:00:00Z"} as unknown as ApplicationForm;
  const inventory: ApplicationInventory = {accountKey,checkedAt:new Date().toISOString(),termId:"437",applications:[]};
  let hasApplication = false;
  const gateway = {getAccount:async()=>({accountKey}),getApplicationForm:async()=>form,
    listApplications:async()=>inventory,getApplicationStatus:async()=>({jobId,hasApplication})} as unknown as ApplicationGateway;
  return {ledger,path,accountKey,jobId,term,operationKey,form,inventory,gateway,presence:()=>{hasApplication=true;}};
}

test("explicit verified recovery preserves the uncertain attempt and permits only a new attempt",async()=>{
  const f=await fixture();
  expect(()=>f.ledger.reserve({attemptId:"blocked",accountKey:f.accountKey,operationKey:f.operationKey,manifestHash:"c".repeat(64),kind:"application"})).toThrow("Operation already");
  const [old]=await authorizeApplicationRetry(f.gateway,f.ledger,f.jobId,f.term,()=>false);
  expect(old).toMatchObject({state:"outcome_unknown",noRemoteMutation:0,retryAuthorizedAt:expect.any(Number),accountReleasedAt:expect.any(Number)});
  expect(JSON.parse(old!.retryEvidence!)).toMatchObject({source:"dashboard_user",jobId:f.jobId,hasApplication:false,freshApprovalRequired:true});
  const reopened=new AttemptLedger(f.path);
  try {
    expect(reopened.get("old")!.retryEvidence).toBe(old!.retryEvidence);
    expect(reopened.events("old").at(-1)!.event).toBe("retry_authorized");
    expect(reopened.reserve({attemptId:"new-approval",accountKey:f.accountKey,operationKey:f.operationKey,manifestHash:"c".repeat(64),kind:"application"}).state).toBe("reserved");
    expect(()=>reopened.reserve({attemptId:"duplicate",accountKey:f.accountKey,operationKey:f.operationKey,manifestHash:"c".repeat(64),kind:"application"})).toThrow("Operation already");
  } finally {reopened.close();}
});

test.each(["presence","inventory","stale","account","term","executing","offline","recent"])("recovery refuses %s evidence and retains its locks",async failure=>{
  const f=await fixture();
  if(failure==="presence") f.presence();
  if(failure==="inventory") f.inventory.applications.push({jobId:f.jobId,term:f.term} as ApplicationInventory["applications"][number]);
  if(failure==="stale") f.inventory.checkedAt=new Date(Date.now()-120_000).toISOString();
  if(failure==="account") f.inventory.accountKey="d".repeat(64);
  if(failure==="term") f.form.term="2026 - Fall";
  if(failure==="offline") f.gateway.getApplicationStatus=async()=>{throw new Error("Offline");};
  const clock=Date.now;
  try {
    if(failure==="recent") Date.now=()=>clock()-150_000;
    await expect(authorizeApplicationRetry(f.gateway,f.ledger,f.jobId,f.term,()=>failure==="executing")).rejects.toThrow();
  } finally {Date.now=clock;}
  expect(f.ledger.get("old")).toMatchObject({retryAuthorizedAt:null,accountReleasedAt:null,noRemoteMutation:0});
});

test("authoritative posting absence plus a fresh supported form permits human recovery when history is unavailable",async()=>{
  const f=await fixture();
  f.gateway.listApplications=async()=>{throw new Error("Applications list request changed");};
  await authorizeApplicationRetry(f.gateway,f.ledger,f.jobId,f.term,()=>false);
  expect(JSON.parse(f.ledger.get("old")!.retryEvidence!)).toMatchObject({hasApplication:false,formOpen:true,inventoryChecked:false,inventoryAbsent:null,freshApprovalRequired:true});
  expect(f.ledger.get("old")!.noRemoteMutation).toBe(0);
});

test("failure phase and reason survive a ledger reopen without raw exception contents",async()=>{
  const f=await fixture();
  f.ledger.recordEvent("old","operation_failed",{phase:"upload_entry",code:"no_remote_mutation",message:"Page control is missing or ambiguous"});
  const reopened=new AttemptLedger(f.path);
  try {expect(reopened.events("old").at(-1)).toMatchObject({event:"operation_failed",failure:{phase:"upload_entry",code:"no_remote_mutation",message:"Page control is missing or ambiguous"}});}
  finally {reopened.close();}
});

test("retry also unlocks the same posting's completed staging operation, retaining upload history",async()=>{
  const f=await fixture();
  f.ledger.releaseAccountQuarantine("old",{accountKey:f.accountKey,jobId:f.jobId,checkedAt:Date.now(),hasApplication:false,reason:"Verified absence"});
  const hash="c".repeat(64), key=fingerprint(["stage_documents",f.accountKey,f.jobId,hash]);
  const clock=Date.now;
  try {
    Date.now=()=>clock()-240_000;
    f.ledger.reserve({attemptId:"staged",accountKey:f.accountKey,operationKey:key,manifestHash:hash,kind:"stage_application_documents"});
    f.ledger.transition("staged","staging");f.ledger.transition("staged","submitting");f.ledger.transition("staged","succeeded");
  } finally {Date.now=clock;}
  await authorizeApplicationRetry(f.gateway,f.ledger,f.jobId,f.term,()=>false);
  expect(f.ledger.get("old")!.retryAuthorizedAt).not.toBeNull();
  expect(f.ledger.get("staged")).toMatchObject({state:"succeeded",noRemoteMutation:0,retryAuthorizedAt:expect.any(Number)});
  expect(JSON.parse(f.ledger.get("staged")!.retryEvidence!)).toMatchObject({uploadsMayExist:true});
  expect(f.ledger.findOperation(key)).toBeNull();
});

test("automatic filled-form checks cannot release failed, uncertain, or submitted application attempts", async () => {
  for (const variant of ["unknown", "submitted", "filled"] as const) {
    const f = await fixture();
    if (variant !== "unknown") f.ledger.transition("old", "succeeded", variant === "submitted" ? "submitted-receipt" : undefined);
    // Transitioning to success updates its age; advance only the check clock.
    const clock = Date.now;
    try {
      Date.now = () => clock() + 180_000;
      const evidence = { accountKey: f.accountKey, jobId: f.jobId, term: f.term, checkedAt: Date.now(), inventoryChecked: true, operationKey: f.operationKey };
      const action = () => f.ledger.authorizeApplicationRetry("old", f.ledger.get("old")!.updatedAt, evidence, "filled_form_check");
      if (variant === "filled") {
        const attempt = action();
        expect(attempt.state).toBe("succeeded");
        expect(JSON.parse(attempt.retryEvidence!)).toMatchObject({ source: "filled_form_check", freshApprovalRequired: true });
        expect(f.ledger.findOperation(f.operationKey)).toBeNull();
      } else {
        expect(action).toThrow("cannot be unlocked");
        expect(f.ledger.get("old")!.retryAuthorizedAt).toBeNull();
      }
    } finally { Date.now = clock; }
  }
});
