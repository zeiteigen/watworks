import { expect, test } from "bun:test";
import { ApplicationSync } from "./application-sync.js";
import type { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";
import type { ApplicationInventory } from "../../application-workflow/src/types.js";
import type { Workspace } from "../../workspace/src/store.js";

function fixture() {
  const inventory: ApplicationInventory = { accountKey: "a", checkedAt: new Date().toISOString(), termId: "437", applications: [] };
  const jobs = [{ key: "waterlooworks:123", status: { state: "outcome_unknown", updatedAt: new Date(Date.now() - 180_000).toISOString(), externalSteps: [] } }];
  const writes: unknown[] = [];
  let term="2027 - Winter"; const savedForms:unknown[]=[];
  let active = false, accountKey = "a", reconciliationReads = 0, hasApplication = false;
  const workspace = { listJobs: async () => jobs, getForm: async () => ({ accountKey, term, externalSteps: ["External task"] }),
    saveForm:async(_key:unknown,value:unknown)=>{savedForms.push(value);},
    getStatus: async () => jobs[0]!.status, getPlan: async () => undefined,
    setStatus: async (_key: unknown, status: unknown) => { writes.push(status); } } as unknown as Workspace;
  const workflow = { getApplicationForm:async()=>({accountKey,jobId:"123",term:"2027 - Winter",hasApplication,externalSteps:["External task"]}), reconcileFilledApplication: async () => { reconciliationReads++; return { hasApplication }; }, listApplications: async () => inventory, reconcileApplication: async () => { reconciliationReads++; return { hasApplication }; } } as unknown as ApplicationWorkflow;
  return { inventory, jobs, writes, sync: new ApplicationSync(workspace, workflow, () => active), setActive: () => { active = true; }, switchAccount: () => { accountKey = "other"; }, reads: () => reconciliationReads,
    savedForms, setTerm:(value:string)=>{term=value;},setPresent: () => { hasApplication = true; } };
}
test("unknown attempts reconcile positively from complete inventory, including external application records", async () => {
  const f = fixture(); f.inventory.applications.push({ applicationId: "900", jobId: "123", term: "2027 - Winter", status: "Applied", title: "Developer", employer: "Acme", location: "Toronto", submittedAt: new Date().toISOString() });
  f.setPresent(); await f.sync.refresh();
  expect(f.writes).toEqual([expect.objectContaining({ state: "applied", applicationId: "900", externalSteps: ["External task"] })]);
});
test("complete absence plus posting readback reports no submission without invoking a write gateway", async () => {
  const f = fixture(); await f.sync.refresh();
  expect(f.reads()).toBe(1); expect(f.writes).toEqual([expect.objectContaining({ state: "failed", reason: expect.stringContaining("No submitted application verified") })]);
});
test("active jobs, wrong accounts, recent failures and contradictory readback do not become absent", async () => {
  for (const variant of ["active", "account", "recent", "present"] as const) {
    const f = fixture();
    if (variant === "active") f.setActive();
    if (variant === "account") f.switchAccount();
    if (variant === "recent") f.jobs[0]!.status.updatedAt = new Date().toISOString();
    if (variant === "present") f.setPresent();
    await f.sync.refresh(); expect(f.writes).toEqual([]);
  }
});

test("filled forms wait two minutes and require verified absence before returning for preparation", async () => {
  for (const variant of ["absent", "recent", "present", "active", "account"] as const) {
    const f = fixture();
    f.jobs[0]!.status.state = "form_filled";
    if (variant === "recent") f.jobs[0]!.status.updatedAt = new Date().toISOString();
    if (variant === "present") f.setPresent();
    if (variant === "active") f.setActive();
    if (variant === "account") f.switchAccount();
    await f.sync.refresh();
    expect(f.writes).toEqual(variant === "absent" ? [expect.objectContaining({ state: "planned", blockers: ["No saved application plan"] })] : []);
  }
});

test("filled forms become verified Applied when the user submitted them in WaterlooWorks", async () => {
  const f = fixture();
  f.jobs[0]!.status.state = "form_filled";
  f.inventory.applications.push({ applicationId: "900", jobId: "123", term: "2027 - Winter", status: "Applied", title: "Developer", employer: "Acme", location: "Toronto", submittedAt: new Date().toISOString() });
  f.setPresent();
  await f.sync.refresh();
  expect(f.writes).toEqual([expect.objectContaining({ state: "applied", applicationId: "900" })]);
});


test("viewing inventory returns local records without submission reconciliation",async()=>{
  const f=fixture();
  f.inventory.applications.push({applicationId:"900",jobId:"123",term:"2027 - Winter",status:"Applied",title:"Developer",employer:"Acme",location:"Toronto",submittedAt:new Date().toISOString()});
  expect(await f.sync.list()).toEqual(f.inventory);
  expect(f.reads()).toBe(0);
  expect(f.writes).toEqual([]);
});


test("legacy filled receipts repair salary-table terms only after account-bound presence verification",async()=>{
  for(const variant of ["verified","wrong-account","wrong-valid-term","not-present"] as const){
    const f=fixture();f.jobs[0]!.status.state="form_filled";
    f.setTerm(variant==="wrong-valid-term"?"2026 - Fall":"First\n$833\nSecond\n$900");
    f.inventory.applications.push({applicationId:"900",jobId:"123",term:"2027 - Winter",status:"Applied",title:"Developer",employer:"Acme",location:"Toronto",submittedAt:new Date().toISOString()});
    if(variant!=="not-present")f.setPresent();
    if(variant==="wrong-account")f.switchAccount();
    await f.sync.refresh();
    if(variant==="verified"){
      expect(f.writes).toEqual([expect.objectContaining({state:"applied",applicationId:"900"})]);
      expect(f.savedForms).toEqual([expect.objectContaining({term:"2027 - Winter"})]);
    }else{expect(f.writes).toEqual([]);expect(f.savedForms).toEqual([]);}
  }
});


test("verified absence refreshes a legacy filled form's malformed recruiting term locally",async()=>{
  const f=fixture();f.jobs[0]!.status.state="form_filled";f.setTerm("First\n$833\nSecond\n$900");
  await f.sync.refresh();
  expect(f.savedForms).toEqual([expect.objectContaining({jobId:"123",term:"2027 - Winter",hasApplication:false})]);
  expect(f.writes).toEqual([expect.objectContaining({state:"planned",blockers:["No saved application plan"]})]);
});
