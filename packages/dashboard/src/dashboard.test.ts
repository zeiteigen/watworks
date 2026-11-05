import { AttemptLedger } from "../../application-workflow/src/ledger.js";
import { SubmissionRecovery } from "./submission-recovery.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { ReviewService } from "../../approval/src/index.js";
import { sha256 } from "../../shared/src/sha256.js";
import { fingerprint } from "../../application-workflow/src/fingerprint.js";
import { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";
import type { ApplicationInventory, ApplicationForm, ApplicationGateway, ApplicationManifest, LibraryDocument, PreparedFile, SubmissionReceipt } from "../../application-workflow/src/types.js";
import { writeAtomic, Workspace } from "../../workspace/src/store.js";
import { planBlockers } from "../../workspace/src/plans.js";
import { ApplicationPlanSchema } from "../../workspace/src/schemas.js";
import { EXPECTED_EXTENSION_ID } from "../../shared/src/extension-protocol.js";
import type { ExtensionMethod } from "../../shared/src/extension-protocol.js";
import { ApplicationSync } from "./application-sync.js";
import { Applier } from "./applier.js";
import { createDashboardFetch } from "./server.js";

const ORIGIN = "http://127.0.0.1:39452";

class FakeGateway implements ApplicationGateway {
  capabilities = { upload: true, defaults: true, submit: true };
  documents: LibraryDocument[] = [];
  writes = { upload: 0, submit: 0 };
  submitted: ApplicationManifest | undefined;
  progressListener: ((progress: import("../../shared/src/application-progress.js").ApplicationProgress) => void) | undefined;
  form: ApplicationForm = {
    accountKey: "a".repeat(64), accountLabel: "Student", jobId: "123", title: "Developer", employer: "Acme", term: "Winter 2027",
    deadline: "2099-01-01T00:00:00Z", canApply: true, hasApplication: false, version: "v1", blockers: [], externalSteps: ["Email the recruiter"],
    requirements: [{ id: "resume", typeId: "1", label: "Resume", required: true, role: "resume" }, { id: "letter", typeId: "2", label: "Cover letter", required: true, role: "attachment" }],
    questions: [{ id: "eligible", label: "Eligible?", type: "single_choice", required: true, options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }],
  };
  async getApplicationForm() { return structuredClone(this.form); }
  async listDocuments() { return structuredClone(this.documents); }
  async getAccount() { return { accountKey: this.form.accountKey, accountLabel: this.form.accountLabel }; }
  async listApplications(): Promise<ApplicationInventory> { return {accountKey:this.form.accountKey,checkedAt:new Date().toISOString(),termId:"437",applications:[]}; }
  watchOperationProgress(_operationId: string, listener: (progress: import("../../shared/src/application-progress.js").ApplicationProgress) => void) {
    this.progressListener = listener;
    return () => { if (this.progressListener === listener) this.progressListener = undefined; };
  }
  async uploadDocument(typeId: string, name: string, file: PreparedFile) {
    this.writes.upload++;
    const doc = { id: `doc-${this.writes.upload}`, typeId, name, revision: file.sha256, state: "ready" as const, source: "library" as const };
    this.documents.push(doc);
    return doc;
  }
  async setDefaultDocuments(_typeId: string, documentIds: string[]) { return { documentIds }; }
  async submitApplication(manifest: ApplicationManifest, _files: ReadonlyMap<string, PreparedFile>, beforeFinalSubmit: () => void): Promise<SubmissionReceipt> {
    beforeFinalSubmit();
    this.progressListener?.({phase:"uploading_document",document:"cover_letter"});
    if (manifest.executionMode === "fill_only") {
      this.submitted = structuredClone(manifest);
      return { applicationId: "", jobId: manifest.jobId, status: "form_filled", manifestHash: fingerprint(manifest), externalSteps: manifest.externalSteps };
    }
    this.writes.submit++;
    this.submitted = structuredClone(manifest);
    this.form.hasApplication = true;
    return { applicationId: "application-1", jobId: manifest.jobId, status: "submitted", manifestHash: fingerprint(manifest), externalSteps: manifest.externalSteps };
  }
  async getApplicationStatus(jobId: string) { return { jobId, hasApplication: this.form.hasApplication }; }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function pdf(path: string, text: string) {
  const document = await PDFDocument.create();
  document.addPage().drawText(text);
  await writeAtomic(path, await document.save());
}

async function fixture(discovery?: { call<T>(method: ExtensionMethod, ...args: unknown[]): Promise<T> }, submissionStatus?:()=>Promise<{connected:boolean;authenticated:boolean;fillOnly:boolean;binding?:string}>) {
  const root = await mkdtemp(join(tmpdir(), "wat-dashboard-test-"));
  const workspace = new Workspace(join(root, "data"));
  await workspace.scaffold();
  const gateway = new FakeGateway();
  const reviews = new ReviewService({ serve: false });
  const workflow = new ApplicationWorkflow({ gateway, documentRoots: [workspace.paths.root], ledgerPath: join(root, "ledger.sqlite"), reviews });
  cleanup.push(async () => { await workflow.close(); await rm(root, { recursive: true, force: true }); });

  const key = { source: "waterlooworks", jobId: "123" };
  await workspace.saveResumeVariant({ variant: "swe", label: "Software", resume: { heading: { name: "Jane" }, sections: [{ kind: "list", title: "Skills", items: ["TypeScript"] }] } });
  await pdf(workspace.paths.resume("swe").pdf, "Resume");
  await workspace.saveResumeVariant({ variant: "data", label: "Data Science", resume: { heading: { name: "Jane" }, sections: [{ kind: "list", title: "Skills", items: ["Python"] }] } });
  await pdf(workspace.paths.resume("data").pdf, "Data Resume");
  await workspace.saveJob(key, { summary: { source: "waterlooworks", jobId: "123", title: "Developer", employer: "Acme", requiredDocuments: [] }, posting: {} }, "# Developer", gateway.form);
  await pdf(workspace.paths.job(key).coverLetterPdf, "Letter");
  const plan = ApplicationPlanSchema.parse({ resumeVariant: "swe", fit: "Good match", rank: 1, attachments: [{ kind: "cover_letter", requirementId: "letter" }], answers: [{ questionId: "eligible", value: "y" }] });
  const blockers = await planBlockers(workspace, key, plan, gateway.form);
  expect(blockers).toEqual([]);
  await workspace.savePlan(key, plan, blockers);

  const applier = new Applier(workspace, workflow, reviews);
  const handle = createDashboardFetch(() => ORIGIN, { workspace, applier, recovery: new SubmissionRecovery(workspace, workflow, () => applier.hasActive), health: async () => ({ authenticated: true, bridgeConnected: true, bootstrapped: true }), ...(discovery ? { discovery } : {}), ...(submissionStatus ? {submissionStatus} : {}) });
  const call = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => handle(new Request(`${ORIGIN}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { host: "127.0.0.1:39452", ...(init.body !== undefined ? { origin: ORIGIN, "content-type": "application/json" } : {}), ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  }));
  return { workspace, gateway, key, call, applier, workflow, ledgerPath: join(root, "ledger.sqlite") };
}

async function waitFor(workspace: Workspace, key: { source: string; jobId: string }, states: string[]) {
  for (let i = 0; i < 400; i++) {
    const status = await workspace.getStatus(key);
    if (status && states.includes(status.state)) return status;
    await Bun.sleep(10);
  }
  throw new Error("Job did not settle");
}

test("an uncertain application leaves subsequent queued jobs ready without starting them", async () => {
  const f=await fixture();
  const next={source:"waterlooworks",jobId:"456"};
  await f.workspace.saveJob(next,{summary:{source:next.source,jobId:next.jobId,title:"Next job",employer:"Other",requiredDocuments:[]},posting:{}},"# Next job",{...f.gateway.form,jobId:next.jobId});
  const ready=await f.workspace.setStatus(next,{state:"ready"});
  let started!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let attempts=0,reads=0;
  const getForm=f.gateway.getApplicationForm.bind(f.gateway);
  f.gateway.getApplicationForm=async()=>{reads++;return getForm();};
  f.gateway.submitApplication=async(_manifest,_files,beforeFinalSubmit)=>{
    attempts++;beforeFinalSubmit();started();await gate;
    throw new Error("Connection lost after a possible write");
  };
  f.applier.enqueue(f.key,key=>f.applier.apply(key));
  await entered;
  const readsBeforeNext=reads;
  f.applier.enqueue(next,key=>f.applier.apply(key));
  release();
  for(let i=0;i<400&&f.applier.hasActive;i++)await Bun.sleep(10);
  expect(f.applier.hasActive).toBe(false);
  expect((await f.workspace.getStatus(f.key))?.state).toBe("outcome_unknown");
  expect(await f.workspace.getStatus(next)).toEqual(ready);
  expect(reads).toBe(readsBeforeNext);
  expect(attempts).toBe(1);
  expect(f.workflow.getBlockingAttempts()).toHaveLength(1);
});

describe("dashboard", () => {
  test("serves APIs without a token and refuses other hosts and POST origins", async () => {
    const { call } = await fixture();
    expect((await call("/api/state")).status).toBe(200);
    expect((await call("/api/state", { headers: { host: "evil.example:39452" } })).status).toBe(403);
    expect((await call("/api/jobs/waterlooworks/123/apply", { body: {}, headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await call("/api/ping", { headers: { authorization: "" } })).status).toBe(200);
  });

  test("accepts only the installed extension origin and bounded JSON preflights", async () => {
    const { call } = await fixture();
    const origin = `chrome-extension://${EXPECTED_EXTENSION_ID}`;
    const response = await call("/api/state", { headers: { origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    const preflight = await call("/api/jobs/waterlooworks/123/remove", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect((await call("/api/jobs/waterlooworks/123/remove", { body: {}, headers: { origin } })).status).toBe(200);
    for (const foreign of ["https://evil.example", "null", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
      const denied = await call("/api/state", { headers: { origin: foreign } });
      expect(denied.status).toBe(403);
      expect(denied.headers.has("access-control-allow-origin")).toBe(false);
      expect((await call("/api/jobs/waterlooworks/123/apply", { body: {}, headers: { origin: foreign } })).status).toBe(403);
    }
    expect((await call("/api/state", { method: "OPTIONS", headers: { origin, "access-control-request-method": "DELETE" } })).status).toBe(403);
  });

  test("human account-block release works offline, audits the decision, and preserves replay protection", async () => {
    const f = await fixture();
    const ledger = new AttemptLedger(f.ledgerPath);
    const clock = Date.now;
    try {
      Date.now = () => clock() - 180_000;
      ledger.reserve({ attemptId: "blocked-attempt", accountKey: f.gateway.form.accountKey, operationKey: fingerprint(["application", f.gateway.form.accountKey, "123", f.gateway.form.term]), manifestHash: "b".repeat(64), kind: "application" });
      ledger.transition("blocked-attempt", "staging");
      ledger.transition("blocked-attempt", "outcome_unknown");
    } finally { Date.now = clock; }
    try {
      // All block inspection/release uses local evidence, even when remote reads fail.
      f.gateway.getAccount = async () => { throw Error("Offline"); };
      const data = await (await f.call("/api/submission-blocks")).json();
      expect(data.blocks[0]).toMatchObject({ id: "blocked-attempt", title: "Developer", canRelease: true });
      const body = { updatedAt: data.blocks[0].updatedAt, acknowledged: true, reason: "I checked this application manually; allow other jobs." };
      const path = "/api/submission-blocks/blocked-attempt/release";
      expect((await f.call(path, { body, headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await f.call(path, { body: { ...body, acknowledged: false } })).status).toBe(400);
      expect((await f.call(path, { body: { ...body, updatedAt: 0 } })).status).toBe(409);
      expect((await f.call(path, { body })).status).toBe(200);
      expect((await (await f.call("/api/submission-blocks")).json()).blocks).toEqual([]);
      const retained = ledger.get("blocked-attempt")!;
      expect(retained.state).toBe("outcome_unknown");
      expect(retained.noRemoteMutation).toBe(0);
      expect(JSON.parse(retained.accountReleaseEvidence!)).toMatchObject({ source: "dashboard_user", reason: body.reason });
      expect((await f.call(path, { body })).status).toBe(409);
      expect(() => ledger.reserve({ attemptId: "replay", accountKey: f.gateway.form.accountKey, operationKey: retained.operationKey, manifestHash: "c".repeat(64), kind: "application" })).toThrow("Operation already");
      expect(ledger.reserve({ attemptId: "other-job", accountKey: f.gateway.form.accountKey, operationKey: "d".repeat(64), manifestHash: "c".repeat(64), kind: "application" }).state).toBe("reserved");
      expect(f.gateway.writes).toEqual({ upload: 0, submit: 0 });
    } finally { ledger.close(); }
  });

  test("rechecking a failed plan prepares it for user review without submitting", async () => {
    const f = await fixture();
    await f.workspace.setStatus(f.key, { state: "failed", reason: "Blocked by previous attempt" });
    const response = await f.call("/api/jobs/waterlooworks/123/recheck", { body: {} });
    expect(response.status).toBe(200);
    expect((await response.json()).status.state).toBe("ready");
    expect(f.gateway.writes).toEqual({ upload: 0, submit: 0 });
  });

  test("human retry unlock checks remote absence and returns to review without uploading or submitting", async () => {
    const f = await fixture();
    const ledger = new AttemptLedger(f.ledgerPath);
    const clock = Date.now;
    try {
      Date.now = () => clock() - 180_000;
      ledger.reserve({attemptId:"uncertain",accountKey:f.gateway.form.accountKey,operationKey:fingerprint(["application",f.gateway.form.accountKey,"123",f.gateway.form.term]),manifestHash:"b".repeat(64),kind:"application"});
      ledger.transition("uncertain","staging"); ledger.transition("uncertain","outcome_unknown");
    } finally {Date.now=clock;}
    try {
      const status=await f.workspace.setStatus(f.key,{state:"outcome_unknown",reason:"Previous attempt interrupted"});
      const path="/api/jobs/waterlooworks/123/unlock-retry";
      const body={acknowledged:true,updatedAt:status.updatedAt};
      expect((await f.call(path,{body,headers:{origin:"https://evil.example"}})).status).toBe(403);
      expect((await f.call(path,{body:{...body,acknowledged:false}})).status).toBe(409);
      f.gateway.form.hasApplication=true;
      expect((await f.call(path,{body})).status).toBe(409);
      expect(ledger.get("uncertain")!.retryAuthorizedAt).toBeNull();
      f.gateway.form.hasApplication=false;
      const response=await f.call(path,{body});
      expect(response.status).toBe(200);
      expect((await response.json()).status.state).toBe("ready");
      expect(ledger.get("uncertain")).toMatchObject({state:"outcome_unknown",noRemoteMutation:0,retryAuthorizedAt:expect.any(Number)});
      expect(f.gateway.writes).toEqual({upload:0,submit:0});
      expect((await f.call(path,{body})).status).toBe(409);
    } finally {ledger.close();}
  });

  test("lists and previews standalone resume variants without a token", async () => {
    const { call } = await fixture();
    const materials = await (await call("/api/materials")).json() as { resumes: Array<{ id: string; label: string; available: boolean }>; documents: Array<{ id: string; key: string; title: string; kind: string; state: string }> };
    expect(materials.resumes).toEqual([
      { id: "data", label: "Data Science", available: true },
      { id: "swe", label: "Software", available: true },
    ]);
    expect(materials.documents).toEqual([{ id: "cover-letter", key: "waterlooworks:123", title: "Cover letter", kind: "cover_letter", state: "ready" }]);
    expect((await call("/api/materials/jobs/waterlooworks/123/cover-letter")).headers.get("content-type")).toBe("application/pdf");
    const response = await call("/api/materials/resumes/swe");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect((await call("/api/materials/resumes/../../profile/profile")).status).not.toBe(200);
  });

  test("lists discoveries and proxies validated policy settings without a token", async () => {
    const calls: Array<{ method: ExtensionMethod; args: unknown[] }> = [];
    const discoveries = [{ id: "123", title: "Developer", employer: "Acme", reasons: ["title: developer (+2)"], score: 2, discoveredAt: "2026-10-31T12:00:00Z" }];
    const policy = { version: 1, timeZone: "America/Toronto", enabled: true, hour: 8, threshold: 2, exclude: [], rules: [{ field: "title", phrase: "developer", weight: 2 }] };
    const discovery = { call: async <T>(method: ExtensionMethod, ...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return (method === "discoveriesList" ? discoveries : policy) as T;
    } };
    const { call } = await fixture(discovery);
    expect(await (await call("/api/discoveries")).json()).toEqual({ discoveries });
    expect(await (await call("/api/discovery-policy")).json()).toEqual({ policy });
    const saved = await call("/api/discovery-policy", { body: { policy } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ policy });
    expect(calls).toEqual([
      { method: "discoveriesList", args: [] },
      { method: "discoveryPolicyGet", args: [] },
      { method: "discoveryPolicySave", args: [policy] },
    ]);
  });

  test("validates discovery policy and requires same-origin settings writes", async () => {
    const calls: ExtensionMethod[] = [];
    const discovery = { call: async <T>(method: ExtensionMethod): Promise<T> => { calls.push(method); return {} as T; } };
    const { call } = await fixture(discovery);
    expect((await call("/api/discovery-policy", { body: { policy: { enabled: true, hour: 25, threshold: 1, rules: [] } } })).status).toBe(400);
    expect((await call("/api/discovery-policy", { body: { policy: { enabled: true, hour: 9, threshold: 1, rules: [], unexpected: true } } })).status).toBe(400);
    expect((await call("/api/discovery-policy", { body: { policy: { enabled: true, hour: 9, threshold: 1, rules: [] } }, headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("keeps workspace routes available when the extension is offline", async () => {
    const discovery = { call: async <T>(): Promise<T> => { throw new Error("bridge unavailable"); } };
    const { call } = await fixture(discovery);
    const discoveries = await call("/api/discoveries");
    const settings = await call("/api/discovery-policy");
    expect(discoveries.status).toBe(503);
    expect((await discoveries.json()).error).toContain("extension is offline");
    expect(settings.status).toBe(503);
    expect((await settings.json()).error).toContain("extension is offline");
    expect((await call("/api/materials")).status).toBe(200);
    expect((await call("/api/state")).status).toBe(200);
  });

  test("applies only what the page showed, uploading the resume once", async () => {
    const { workspace, gateway, key, call } = await fixture();
    const state = await (await call("/api/state")).json() as { jobs: Array<{ key: string; approvalHash: string; status: { state: string } }> };
    expect(state.jobs).toHaveLength(1);
    const job = state.jobs[0]!;
    expect(job.status.state).toBe("ready");

    const detail = await (await call("/api/jobs/waterlooworks/123")).json() as { answers: unknown[] };
    expect(detail.answers).toEqual([{ question: "Eligible?", answer: "Yes" }]);

    // A changed cover letter invalidates the hash the user approved.
    await pdf(workspace.paths.job(key).coverLetterPdf, "Different letter");
    expect((await call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash: job.approvalHash } })).status).toBe(409);
    expect(gateway.writes).toEqual({ upload: 0, submit: 0 });

    const fresh = (await (await call("/api/state")).json() as typeof state).jobs[0]!;
    expect((await call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash: fresh.approvalHash } })).status).toBe(202);
    const status = await waitFor(workspace, key, ["applied", "failed", "outcome_unknown"]);
    expect(status).toMatchObject({ state: "applied", applicationId: "application-1", externalSteps: ["Email the recruiter"] });
    expect(gateway.writes).toEqual({ upload: 1, submit: 1 });
    expect(gateway.submitted?.answers).toMatchObject([{ questionId: "eligible", value: "y" }]);
    expect((await workspace.getResumeUploads("swe")).uploads).toMatchObject([{ documentId: "doc-1", source: "waterlooworks" }]);

    // Applied jobs cannot be applied to again.
    expect((await call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash: fresh.approvalHash } })).status).toBe(409);
  });

  test("streamed browser progress reaches the job card and late telemetry never overwrites completion", async () => {
    const { call, workspace, key, gateway } = await fixture();
    let finish: (() => void) | undefined;
    const original = gateway.submitApplication.bind(gateway);
    gateway.submitApplication = async (...args) => {
      await new Promise<void>(resolve => { finish = resolve; gateway.progressListener?.({phase:"uploading_document",document:"cover_letter"}); });
      return original(...args);
    };
    Object.assign(gateway, {getOperationProgress:async () => { throw new Error("Progress must be streamed, not polled"); }});
    const state = await (await call("/api/state")).json() as { jobs:Array<{approvalHash:string}> };
    expect((await call("/api/jobs/waterlooworks/123/apply", {body:{approvalHash:state.jobs[0]!.approvalHash,executionMode:"fill_only"}})).status).toBe(202);
    try {
      const deadline = Date.now() + 4000;
      let reason = "";
      while (Date.now() < deadline) {
        reason = (await workspace.getStatus(key))?.reason ?? "";
        if (finish && reason === "Uploading cover letter") break;
        await Bun.sleep(10);
      }
      expect(finish).toBeDefined();
      expect(reason).toBe("Uploading cover letter");
      const live = await (await call("/api/state")).json() as {jobs:Array<{status:{reason:string}}>};
      expect(live.jobs[0]!.status.reason).toBe("Uploading cover letter");
      const lateTelemetry = gateway.progressListener;
      expect(lateTelemetry).toBeDefined();
      finish!();
      expect((await waitFor(workspace,key,["form_filled","failed"])).state).toBe("form_filled");
      lateTelemetry!({phase:"submitting"});
      await Bun.sleep(20);
      expect((await workspace.getStatus(key))?.reason).toStartWith("Form filled.");
    } finally { finish?.(); }
    expect((await workspace.getStatus(key))?.reason).toStartWith("Form filled.");
    expect(gateway.writes.submit).toBe(0);
  });

  test("fills without submitting and defers application verification", async () => {
    const { call, workspace, key, gateway } = await fixture();
    const state = await (await call("/api/state")).json() as { jobs: Array<{ approvalHash: string }> };
    const approvalHash = state.jobs[0]!.approvalHash;
    expect((await call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash, executionMode: "invalid" } })).status).toBe(400);
    expect(gateway.writes).toEqual({ upload: 0, submit: 0 });
    expect((await call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash, executionMode: "fill_only" } })).status).toBe(202);
    const status = await waitFor(workspace, key, ["form_filled", "failed", "outcome_unknown"]);
    expect(status.state).toBe("form_filled");
    expect(status.applicationId).toBeUndefined();
    expect(gateway.submitted?.executionMode).toBe("fill_only");
    expect(gateway.writes).toEqual({ upload: 1, submit: 0 });
    expect(gateway.form.hasApplication).toBe(false);
    expect((await call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash } })).status).toBe(409);
    expect((await call("/api/jobs/waterlooworks/123/manual", { body: {} })).status).toBe(404);
    expect((await workspace.getStatus(key))?.state).toBe("form_filled");
  });

  test("job details include full requirements and questions before a plan exists", async () => {
    const { workspace, gateway, call } = await fixture();
    const key = { source: "waterlooworks", jobId: "456" };
    await workspace.saveJob(key, { summary: { source: key.source, jobId: key.jobId, title: "Unplanned", employer: "Acme", requiredDocuments: [] }, posting: {} }, "Full saved responsibilities", { ...gateway.form, jobId: key.jobId });
    const detail = await (await call("/api/jobs/waterlooworks/456")).json() as { description: string; requirements: unknown[]; questions: unknown[]; answers: unknown[] };
    expect(detail.description).toBe("Full saved responsibilities");
    expect(detail.requirements).toContainEqual({ id: "letter", label: "Cover letter", required: true, role: "attachment" });
    expect(detail.questions).toContainEqual(gateway.form.questions[0]);
    expect(detail.answers).toEqual([]);
    await workspace.saveJob({ source: "waterlooworks", jobId: "789" }, { summary: { source: "waterlooworks", jobId: "789", title: "No form", employer: "Acme", requiredDocuments: [] }, posting: {} }, "Posting without a form");
    const missing = await (await call("/api/jobs/waterlooworks/789")).json() as { requirements: unknown; questions: unknown };
    expect(missing.requirements).toBeNull();
    expect(missing.questions).toBeNull();
    expect(gateway.writes).toEqual({ upload: 0, submit: 0 });
  });

  test("queued approval keeps the original PDFs when workspace materials are regenerated", async () => {
    const {call,workspace,key,gateway}=await fixture();
    const resumeHash=sha256(new Uint8Array(await readFile(workspace.paths.resume("swe").pdf)));
    const letterHash=sha256(new Uint8Array(await readFile(workspace.paths.job(key).coverLetterPdf)));
    let release!:()=>void;let started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const original=gateway.getApplicationForm.bind(gateway);
    gateway.getApplicationForm=async()=>{started();await gate;return original();};
    const state=await (await call("/api/state")).json() as {jobs:Array<{approvalHash:string}>};
    expect((await call("/api/jobs/waterlooworks/123/apply",{body:{approvalHash:state.jobs[0]!.approvalHash}})).status).toBe(202);
    await entered;
    await pdf(workspace.paths.resume("swe").pdf,"Regenerated resume after approval");
    await pdf(workspace.paths.job(key).coverLetterPdf,"Regenerated letter after approval");
    release();
    expect((await waitFor(workspace,key,["applied","failed","outcome_unknown"])).state).toBe("applied");
    expect(gateway.documents[0]!.revision).toBe(resumeHash);
    expect(gateway.submitted!.documents.find(doc=>doc.requirementId==="letter")!.file!.sha256).toBe(letterHash);
  });

  test("records blockers from WaterlooWorks without submitting", async () => {
    const { workspace, gateway, key, call } = await fixture();
    gateway.form.deadline = "2000-01-01T00:00:00Z";
    const job = (await (await call("/api/state")).json() as { jobs: Array<{ approvalHash: string }> }).jobs[0]!;
    expect((await call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash: job.approvalHash } })).status).toBe(202);
    const status = await waitFor(workspace, key, ["planned", "applied"]);
    expect(status.state).toBe("planned");
    expect(gateway.writes.upload).toBe(0);
    expect(status.blockers).toContain("Application deadline is unknown or has passed");
    expect(gateway.writes.submit).toBe(0);
  });

  test("a newly required generic attachment is blocked before any upload", async () => {
    const { workspace, gateway, key, call } = await fixture();
    gateway.form.requirements.push({ id: "other", typeId: "70", label: "Other - Per Job Posting", required: true, role: "attachment" });
    const job = (await (await call("/api/state")).json() as { jobs: Array<{ approvalHash: string }> }).jobs[0]!;
    expect((await call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash: job.approvalHash } })).status).toBe(202);
    const status = await waitFor(workspace, key, ["planned", "failed"]);
    expect(status.state).toBe("planned");
    expect(status.blockers).toContain("Missing document: Other - Per Job Posting");
    expect(gateway.writes).toEqual({ upload: 0, submit: 0 });
  });

  test("expired jobs are archived and cannot be restored or submitted", async () => {
    const { workspace, gateway, key, call } = await fixture();
    const job = (await (await call("/api/state")).json() as { jobs: Array<{ approvalHash: string }> }).jobs[0]!;
    gateway.form.deadline = "2000-01-01T00:00:00Z";
    await workspace.saveForm(key, gateway.form);
    const state = await (await call("/api/state")).json() as { jobs: Array<{ status: { state: string; removedFromQueueAt: string; reason: string } }> };
    expect(state.jobs[0]!.status.state).toBe("skipped");
    expect(state.jobs[0]!.status.removedFromQueueAt).toBeTruthy();
    expect(state.jobs[0]!.status.reason).toContain("deadline has passed");
    for (const action of ["apply", "requeue"]) {
      expect((await call("/api/jobs/waterlooworks/123/" + action, { body: { approvalHash: job.approvalHash } })).status).toBe(409);
    }
    expect(await workspace.getPlan(key)).toBeDefined();
    expect((await workspace.listJobDocuments(key)).length).toBe(1);
    expect(gateway.writes).toEqual({ upload: 0, submit: 0 });
  });

  test("keeps a WaterlooWorks link while obsolete manual/skip actions are unavailable", async () => {
    const { workspace, gateway, key, call } = await fixture();
    await workspace.setStatus(key, { state: "planned", blockers: ["Missing document: Other"] });
    const job = (await (await call("/api/state")).json()).jobs[0];
    expect(job.manualApply.hint).toContain("123");
    for (const action of ["manual", "skip", "restore"]) expect((await call("/api/jobs/waterlooworks/123/" + action, { body: {} })).status).toBe(404);
    expect((await workspace.getStatus(key))?.state).toBe("planned");
    expect(gateway.writes).toEqual({ upload: 0, submit: 0 });
  });

  test("removes and restores queued jobs without deleting materials or submitting", async () => {
    const { workspace, gateway, key, call } = await fixture();
    const path = "/api/jobs/waterlooworks/123";
    expect((await call(path + "/remove", { body: {}, headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await call(path + "/remove", { body: {}, headers: { "content-type": "text/plain" } })).status).toBe(400);
    expect((await call(path + "/remove", { body: {} })).status).toBe(200);
    expect((await workspace.getStatus(key))?.removedFromQueueAt).toBeDefined();
    expect((await workspace.listJobs())[0]?.status.state).toBe("ready");
    expect((await call(path + "/files/cover-letter")).status).toBe(200);
    expect((await call(path + "/apply", { body: {} })).status).toBe(409);
    // Reloading the workspace and re-planning must not undo the user's removal.
    const reopened = new Workspace(workspace.paths.root);
    await reopened.savePlan(key, await reopened.getPlan(key), []);
    expect((await reopened.getStatus(key))?.removedFromQueueAt).toBeDefined();
    expect((await call(path + "/requeue", { body: {} })).status).toBe(200);
    expect((await workspace.getStatus(key))?.removedFromQueueAt).toBeUndefined();
    expect((await workspace.getStatus(key))?.state).toBe("ready");
    expect(gateway.writes).toEqual({ upload: 0, submit: 0 });
  });

  test("cannot remove approved queued work or unresolved application states", async () => {
    const { workspace, key, call, applier } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    applier.enqueue(key, () => gate);
    try {
      expect((await call("/api/jobs/waterlooworks/123/remove", { body: {} })).status).toBe(409);
      expect((await workspace.getStatus(key))?.removedFromQueueAt).toBeUndefined();
    } finally { release(); }
    while (applier.isActive(key)) await Bun.sleep(1);
    for (const state of ["applying", "confirm_required", "outcome_unknown", "applied"] as const) {
      await workspace.setStatus(key, { state });
      expect((await call("/api/jobs/waterlooworks/123/remove", { body: {} })).status).toBe(409);
    }
  });

  test("serves local brand fonts and a restrictive content security policy", async () => {
    const { call } = await fixture();
    const response = await call("/fonts/caveat.ttf");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/ttf");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect((await call("/")).headers.get("content-security-policy")).toContain("font-src 'self'");
  });

  test("legacy skipped jobs restore through the removed queue and revalidate the plan", async () => {
    const { workspace, key, call } = await fixture();
    await workspace.setStatus(key, { state: "skipped", reason: "Previously skipped" });
    expect((await call("/api/jobs/waterlooworks/123/requeue", { body: {} })).status).toBe(200);
    expect(await workspace.getStatus(key)).toMatchObject({ state: "ready" });
    expect((await workspace.getStatus(key))?.removedFromQueueAt).toBeUndefined();
  });

});

describe("in-process approval", () => {
  test("is unavailable when the review service serves its own page", () => {
    const reviews = new ReviewService();
    expect(() => reviews.approveInProcess("x", "y")).toThrow("non-serving");
  });
});

// Use the real workflow and ledger to ensure queue recovery permits a new approval,
// while leaving every remote write behind an explicit Apply click.
test("unsubmitted filled forms return to ready after the delay and can be applied to again", async () => {
  const f = await fixture();
  const approvalHash = (await (await f.call("/api/state")).json()).jobs[0].approvalHash;
  await f.call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash, executionMode: "fill_only" } });
  await waitFor(f.workspace, f.key, ["form_filled"]);
  while (f.applier.hasActive) await Bun.sleep(1);
  const clock = Date.now;
  const sync = new ApplicationSync(f.workspace, f.workflow, key => f.applier.isActive(key));
  f.gateway.listApplications = async () => ({ accountKey: f.gateway.form.accountKey, checkedAt: new Date(Date.now()).toISOString(), termId: "437", applications: [] });
  await sync.refresh();
  expect((await f.workspace.getStatus(f.key))?.state).toBe("form_filled");
  try {
    Date.now = () => clock() + 180_000;
    await sync.refresh(true);
    expect((await f.workspace.getStatus(f.key))?.state).toBe("ready");
    expect(f.gateway.writes).toEqual({ upload: 1, submit: 0 });
    const ledger = new AttemptLedger(f.ledgerPath);
    try {
      expect(ledger.recoveryAttempts(f.gateway.form.accountKey, "123", f.gateway.form.term)).toHaveLength(0);
    } finally { ledger.close(); }
  } finally { Date.now = clock; }
  await f.call("/api/jobs/waterlooworks/123/apply", { body: { approvalHash } });
  expect((await waitFor(f.workspace, f.key, ["applied", "failed"])).state).toBe("applied");
  expect(f.gateway.writes).toEqual({ upload: 1, submit: 1 });
});

test("guided recovery verifies submitted jobs even when WaterlooWorks no longer offers their form", async () => {
  const f = await fixture();
  const status = await f.workspace.setStatus(f.key, { state: "outcome_unknown" });
  f.gateway.form.hasApplication = true;
  f.gateway.getApplicationForm = async () => { throw Error("Already applied; form unavailable"); };
  const response = await f.call("/api/jobs/waterlooworks/123/recover", { body: { acknowledged: true, updatedAt: status.updatedAt } });
  expect(response.status).toBe(200);
  expect((await response.json()).status.state).toBe("applied");
  expect(f.gateway.writes).toEqual({ upload: 0, submit: 0 });
});

test.each(["failed", "planned"] as const)("guided recovery revalidates a %s job without a locked attempt", async state => {
  const f = await fixture();
  const status = await f.workspace.setStatus(f.key, { state });
  const path = "/api/jobs/waterlooworks/123/recover";
  expect((await f.call(path, { body: { acknowledged: false, updatedAt: status.updatedAt } })).status).toBe(409);
  expect((await f.call(path, { body: { acknowledged: true, updatedAt: "old" } })).status).toBe(409);
  const response = await f.call(path, { body: { acknowledged: true, updatedAt: status.updatedAt } });
  expect(response.status).toBe(200);
  expect((await response.json()).status.state).toBe("ready");
  expect(f.gateway.writes).toEqual({ upload: 0, submit: 0 });
});

test("guided recovery rejects the wrong WaterlooWorks account before changing status", async () => {
  const f = await fixture();
  const status = await f.workspace.setStatus(f.key, { state: "failed" });
  f.gateway.form.accountKey = "b".repeat(64);
  expect((await f.call("/api/jobs/waterlooworks/123/recover", { body: { acknowledged: true, updatedAt: status.updatedAt } })).status).toBe(409);
  expect((await f.workspace.getStatus(f.key))?.state).toBe("failed");
  expect(f.gateway.writes).toEqual({ upload: 0, submit: 0 });
});

test("empty or missing form requirements expose posting document requirements", async () => {
  const f = await fixture();
  const key = { source: "waterlooworks", jobId: "456" };
  await f.workspace.saveJob(key, { summary: { source: "waterlooworks", jobId: "456", title: "Developer", employer: "Acme", requiredDocuments: ["Resume", "Cover letter"] }, posting: {} }, "Posting");
  for (const form of [undefined, { ...f.gateway.form, jobId: "456", requirements: [] }]) {
    if (form) await f.workspace.saveForm(key, form);
    const detail = await (await f.call("/api/jobs/waterlooworks/456")).json();
    expect(detail.requirements).toBeNull();
    expect(detail.postingRequiredDocuments).toEqual(["Resume", "Cover letter"]);
  }
});

test("guided recovery reconciles an old uncertain attempt when inventory verifies submission", async () => {
  const f = await fixture();
  const ledger = new AttemptLedger(f.ledgerPath);
  const clock = Date.now;
  try {
    Date.now = () => clock() - 180_000;
    ledger.reserve({ attemptId: "submitted-elsewhere", accountKey: f.gateway.form.accountKey, operationKey: fingerprint(["application", f.gateway.form.accountKey, "123", f.gateway.form.term]), manifestHash: "b".repeat(64), kind: "application" });
    ledger.transition("submitted-elsewhere", "staging");
    ledger.transition("submitted-elsewhere", "outcome_unknown");
  } finally { Date.now = clock; }
  try {
    const status = await f.workspace.setStatus(f.key, { state: "outcome_unknown" });
    f.gateway.form.hasApplication = true;
    f.gateway.listApplications = async () => ({ accountKey: f.gateway.form.accountKey, checkedAt: new Date().toISOString(), termId: "437", applications: [{ jobId: "123", term: f.gateway.form.term, status: "Applied", applicationId: "900", title: "Developer", employer: "Acme", location: "Waterloo", submittedAt: new Date().toISOString() }] });
    const response = await f.call("/api/jobs/waterlooworks/123/recover", { body: { acknowledged: true, updatedAt: status.updatedAt } });
    expect(response.status).toBe(200);
    expect((await response.json()).status.state).toBe("applied");
    expect(ledger.get("submitted-elsewhere")).toMatchObject({ state: "succeeded", receiptId: "900" });
    expect(ledger.listAccountBlocks()).toEqual([]);
    expect(f.gateway.writes).toEqual({ upload: 0, submit: 0 });
  } finally { ledger.close(); }
});

test.each(["submit", "fill_only", "changed"] as const)("processed attachments self-check after one Apply click: %s", async mode => {
  const f = await fixture();
  const gateway: ApplicationGateway = f.gateway;
  const snapshots = new Map<string, {document:LibraryDocument;bytes:Uint8Array}>();
  const upload = f.gateway.uploadDocument.bind(f.gateway);
  f.gateway.uploadDocument = async (type, name, file) => {
    const document = await upload(type,name,file);
    snapshots.set(document.id,{document,bytes:file.bytes});
    return document;
  };
  let stages = 0;
  gateway.stageAttachments = async (_manifest, files) => {
    stages++;
    const pdf = await PDFDocument.load(files.get("letter")!.bytes);
    pdf.setTitle("Processed by WaterlooWorks");
    const bytes = await pdf.save();
    const document:LibraryDocument = {id:"processed-letter",typeId:"2",name:"letter.pdf",revision:sha256(bytes),state:"ready",source:"library"};
    snapshots.set(document.id,{document,bytes});
    return [{requirementId:"letter",document,bytes}];
  };
  gateway.getDocumentSnapshot = async id => {
    const snapshot = snapshots.get(id)!;
    return structuredClone(mode === "changed" && id === "processed-letter" ? {...snapshot,document:{...snapshot.document,revision:"changed"}} : snapshot);
  };
  const approvalHash = (await (await f.call("/api/state")).json()).jobs[0].approvalHash;
  expect((await f.call("/api/jobs/waterlooworks/123/apply",{body:{approvalHash,executionMode:mode === "fill_only" ? "fill_only" : "submit"}})).status).toBe(202);
  const status = await waitFor(f.workspace,f.key,["applied","form_filled","failed","confirm_required"]);
  expect(status.state).toBe(mode === "changed" ? "failed" : mode === "fill_only" ? "form_filled" : "applied");
  expect(stages).toBe(1);
  expect(f.gateway.writes).toEqual({upload:1,submit:mode === "submit" ? 1 : 0});
  expect(f.applier.pending(f.key)).toBeUndefined();
  if (mode !== "changed") expect(f.gateway.submitted?.documents.find(d=>d.requirementId === "letter")?.storedDocument?.id).toBe("processed-letter");
});


test("server endpoint/session changes invalidate displayed dashboard approvals",async()=>{
  let binding="a".repeat(64);
  const f=await fixture(undefined,async()=>({connected:true,authenticated:true,fillOnly:false,binding}));
  const state=await (await f.call("/api/state")).json();
  expect(state.submission.fillOnly).toBe(false);
  const approvalHash=state.jobs[0].approvalHash;
  binding="b".repeat(64);
  const response=await f.call("/api/jobs/waterlooworks/123/apply",{body:{approvalHash}});
  expect(response.status).toBe(409);
  expect(f.gateway.writes).toEqual({upload:0,submit:0});
});

test("dashboard rejects fill-only on a server without the capability",async()=>{
  const f=await fixture(undefined,async()=>({connected:true,authenticated:true,fillOnly:false,binding:"a".repeat(64)}));
  const state=await (await f.call("/api/state")).json();
  const response=await f.call("/api/jobs/waterlooworks/123/apply",{body:{approvalHash:state.jobs[0].approvalHash,executionMode:"fill_only"}});
  expect(response.status).toBe(409);
  expect(f.gateway.writes).toEqual({upload:0,submit:0});
});

test("an approved execution pins all workflow phases to its selected endpoint",async()=>{
  const {submissionBindingScope}=await import("../../bridge/src/submission-binding.js");
  const binding="c".repeat(64),observed:Array<string|undefined>=[];
  const f=await fixture(undefined,async()=>({connected:true,authenticated:true,fillOnly:true,binding}));
  const original=f.gateway.submitApplication.bind(f.gateway);
  f.gateway.submitApplication=async(...args:Parameters<typeof original>)=>{observed.push(submissionBindingScope.getStore());return original(...args);};
  const state=await (await f.call("/api/state")).json();
  expect((await f.call("/api/jobs/waterlooworks/123/apply",{body:{approvalHash:state.jobs[0].approvalHash}})).status).toBe(202);
  await waitFor(f.workspace,f.key,["applied"]);
  expect(observed).toEqual([binding]);
  expect(submissionBindingScope.getStore()).toBeUndefined();
});
