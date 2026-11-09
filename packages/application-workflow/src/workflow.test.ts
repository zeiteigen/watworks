import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import { ReviewService, ReviewBeforeMutationError, type CreatedReview } from "../../approval/src/index.js";
import { fingerprint } from "./fingerprint.js";
import { AttemptLedger } from "./ledger.js";
import { ApplicationWorkflow } from "./workflow.js";
import type { ApplicationForm, ApplicationGateway, ApplicationInput, ApplicationManifest, LibraryDocument, PreparedFile, SubmissionReceipt } from "./types.js";

class FakeGateway implements ApplicationGateway {
  capabilities = { upload: true, defaults: true, submit: true };
  accountKey = "a".repeat(64);
  accountLabel = "Student";
  documents: LibraryDocument[] = [{ id: "resume-1", typeId: "1", name: "Resume", revision: "c".repeat(64), state: "ready", source: "library" }];
  form: ApplicationForm = {
    accountKey: this.accountKey, accountLabel: this.accountLabel, jobId: "123", title: "Developer", employer: "Example", term: "Winter 2027",
    deadline: "2099-01-01T00:00:00Z", canApply: true, hasApplication: false, version: "v1", blockers: [], externalSteps: ["Complete employer questionnaire"],
    requirements: [
      { id: "resume", typeId: "1", label: "Resume", required: true, role: "resume" },
      { id: "letter", typeId: "2", label: "Cover letter", required: true, role: "attachment" },
    ], questions: [{ id: "authorized", label: "Authorized?", type: "boolean", required: true }],
  };
  writes = { submit: 0, upload: 0, defaults: 0 };
  submitError: Error | undefined;
  receiptHash: string | undefined;
  submitted: { manifest: ApplicationManifest; files: Map<string, PreparedFile> } | undefined;
  uploaded: PreparedFile | undefined;
  async getApplicationForm() { return structuredClone(this.form); }
  async listDocuments() { return structuredClone(this.documents); }
  async getAccount() { return { accountKey: this.accountKey, accountLabel: this.accountLabel }; }
  async uploadDocument(typeId: string, name: string, file: PreparedFile, accountKey: string) {
    expect(accountKey).toBe(this.accountKey);
    this.writes.upload++;
    this.uploaded = structuredClone(file);
    return { id: "uploaded-1", typeId, name, revision: file.sha256, state: "ready" as const, source: "library" as const };
  }
  async setDefaultDocuments(_typeId: string, documentIds: string[], accountKey: string) {
    expect(accountKey).toBe(this.accountKey);
    this.writes.defaults++;
    return { documentIds };
  }
  async submitApplication(manifest: ApplicationManifest, files: ReadonlyMap<string, PreparedFile>, beforeFinalSubmit: () => void): Promise<SubmissionReceipt> {
    beforeFinalSubmit();
    this.writes.submit++;
    this.submitted = { manifest: structuredClone(manifest), files: structuredClone(new Map(files)) };
    if (this.submitError) throw this.submitError;
    return { applicationId: manifest.executionMode === "fill_only" ? "" : "application-1", jobId: manifest.jobId, status: manifest.executionMode === "fill_only" ? "form_filled" : "submitted", manifestHash: this.receiptHash ?? fingerprint(manifest), externalSteps: manifest.externalSteps };
  }
  async getApplicationStatus(jobId: string) { return { jobId, hasApplication: false }; }
}

const roots: string[] = [];
const workflows: ApplicationWorkflow[] = [];
async function pdf(path: string, text = "Original letter") {
  const document = await PDFDocument.create();
  document.addPage().drawText(text);
  await writeFile(path, await document.save());
}
async function fixture(reviews = new ReviewService()) {
  services.push(reviews);
  const root = await mkdtemp(join(tmpdir(), "application-workflow-test-"));
  roots.push(root);
  const documentRoot = join(root, "documents");
  await mkdir(documentRoot, { mode: 0o700 });
  const path = join(documentRoot, "letter.pdf");
  await pdf(path);
  const ledgerPath = join(root, "state", "attempts.sqlite");
  const gateway = new FakeGateway();
  const options = { gateway, documentRoots: [documentRoot], ledgerPath, reviews };
  const workflow = new ApplicationWorkflow(options);
  workflows.push(workflow);
  const input: ApplicationInput = { jobId: "123", resumeDocumentId: "resume-1", attachments: [{ requirementId: "letter", filePath: path }], answers: [{ questionId: "authorized", value: false }] };
  return { workflow, gateway, input, path, root, ledgerPath, reviews, options };
}
afterEach(async () => {
  for (const workflow of workflows.splice(0)) await workflow.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function prepare(workflow: ApplicationWorkflow, input: ApplicationInput) {
  const result = await workflow.prepareApplication(input);
  expect(result.status).toBe("prepared");
  if (!result.draftId || !result.manifest || !result.manifestHash) throw new Error("Fixture did not prepare");
  return { draftId: result.draftId, manifest: result.manifest, manifestHash: result.manifestHash };
}
const services: ReviewService[] = [];
function serviceFor(review: CreatedReview): ReviewService {
  const service = services.find(item => item.inspect(review.operationId));
  if (!service) throw new Error("Review is missing");
  return service;
}
function snapshot(review: CreatedReview) {
  const data = serviceFor(review).inspect(review.operationId)!;
  return { ...data, manifest: data.manifest as Record<string, any> };
}
/** What the dashboard does for a verified click: 202 when it runs, 409 when it is refused. */
async function approve(review: CreatedReview, body?: { manifestHash: string }): Promise<{ status: number }> {
  return { status: serviceFor(review).approve(review.operationId, (body ?? snapshot(review)).manifestHash) ? 202 : 409 };
}
async function settled(workflow: ApplicationWorkflow, review: CreatedReview) {
  for (let count = 0; count < 200; count++) {
    const result = workflow.getOperationStatus(review.operationId);
    if (result.status !== "awaiting_approval" && result.status !== "executing") return result;
    await Bun.sleep(5);
  }
  throw new Error("Operation did not settle within one second");
}

describe("application approval workflow", () => {
  test.each([false, true])("server-processed PDFs require a second human approval and reject changes: %s", async changed => {
    const f = await fixture();
    const processed = await PDFDocument.create(); processed.addPage().drawText("Server-processed PDF");
    const bytes = await processed.save();
    const document: LibraryDocument = { id: "201", typeId: "2", name: "letter.pdf", revision: createHash("sha256").update(bytes).digest("hex"), state: "ready", source: "library" };
    let stages = 0; let modified = false;
    const gateway = f.gateway as ApplicationGateway;
    gateway.stageAttachments = async () => { stages++; return [{ requirementId: "letter", document: { ...document }, bytes }]; };
    gateway.getDocumentSnapshot = async () => ({ document: { ...document, ...(modified ? { revision: "changed" } : {}) }, bytes });
    const draft = await prepare(f.workflow, f.input);
    const first = await f.workflow.submitApplication(draft.draftId);
    expect((await approve(first)).status).toBe(202);
    const staged = await settled(f.workflow, first);
    expect(staged.status).toBe("review_required");
    expect(stages).toBe(1); expect(f.gateway.writes.submit).toBe(0);
    const next = (staged as { result: unknown }).result as CreatedReview;
    const snap = await snapshot(next);
    expect(snap.manifest.documents[1].storedDocument.revision).toBe(document.revision);
    expect(Buffer.from(f.reviews.document(next.operationId, "letter")!)).toEqual(Buffer.from(bytes));
    modified = changed;
    expect((await approve(next)).status).toBe(202);
    expect((await settled(f.workflow, next)).status).toBe(changed ? "invalidated" : "succeeded");
    expect(f.gateway.writes.submit).toBe(changed ? 0 : 1); expect(stages).toBe(1);
    if (!changed) expect(f.gateway.submitted?.manifest.documents[1]?.storedDocument?.id).toBe("201");
  });

  test("fill-only mode survives processed PDF review and verifies a form-filled receipt", async () => {
    const f = await fixture();
    const processed = await PDFDocument.create(); processed.addPage().drawText("Server-processed PDF");
    const bytes = await processed.save();
    const document: LibraryDocument = { id: "201", typeId: "2", name: "letter.pdf", revision: createHash("sha256").update(bytes).digest("hex"), state: "ready", source: "library" };
    const gateway: ApplicationGateway = f.gateway;
    gateway.stageAttachments = async () => [{ requirementId: "letter", document: { ...document }, bytes }];
    gateway.getDocumentSnapshot = async () => ({ document: { ...document }, bytes });

    const draft = await f.workflow.prepareApplication(f.input, "fill_only");
    expect(draft.status).toBe("prepared");
    if (!draft.draftId || !draft.manifest) throw new Error("Fixture did not prepare");
    expect(draft.manifest.executionMode).toBe("fill_only");
    const first = await f.workflow.submitApplication(draft.draftId);
    expect((await snapshot(first)).manifest.executionMode).toBe("fill_only");
    expect((await approve(first)).status).toBe(202);
    const staged = await settled(f.workflow, first);
    expect(staged.status).toBe("review_required");
    const next = (staged as { result: unknown }).result as CreatedReview;
    const processedReview = await snapshot(next);
    expect(processedReview.manifest.executionMode).toBe("fill_only");
    expect(processedReview.manifest.documents[1].storedDocument.id).toBe("201");

    expect((await approve(next)).status).toBe(202);
    const result = await settled(f.workflow, next);
    expect(result.status).toBe("succeeded");
    expect("result" in result && result.result).toMatchObject({ applicationId: "", jobId: "123", status: "form_filled", manifestHash: processedReview.manifestHash });
    expect(f.gateway.submitted?.manifest.executionMode).toBe("fill_only");
    expect(f.gateway.submitted?.manifest.documents[1]?.storedDocument?.id).toBe("201");
    expect(f.gateway.writes.submit).toBe(1);
  });

  test("concurrent preparations cannot exceed retained draft capacity", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => f.workflow.prepareApplication(f.input)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(16);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(4);
    expect(f.gateway.writes).toEqual({ submit: 0, upload: 0, defaults: 0 });
  });

  test("preparation captures exact content with no mutations or credential/path disclosure", async () => {
    const f = await fixture();
    const prepared = await prepare(f.workflow, f.input);
    expect(f.gateway.writes).toEqual({ submit: 0, upload: 0, defaults: 0 });
    expect(prepared.manifestHash).toBe(fingerprint(prepared.manifest));
    expect(prepared.manifest.answers[0]?.value).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(f.root);
    expect(JSON.stringify(prepared)).not.toContain('"bytes"');
    prepared.manifest.documents.length = 0;
    f.input.answers[0]!.value = true;
    const review = await f.workflow.submitApplication(prepared.draftId);
    const data = await snapshot(review);
    expect(data.manifest.documents).toHaveLength(2);
    expect(data.manifest.answers[0].value).toBe(false);
    expect(f.gateway.writes.submit).toBe(0);
  });

  test("approval submits exactly once and binds the receipt to the reviewed hash", async () => {
    const f = await fixture();
    const prepared = await prepare(f.workflow, f.input);
    const review = await f.workflow.submitApplication(prepared.draftId);
    expect(await f.workflow.submitApplication(prepared.draftId)).toEqual(review);
    const data = await snapshot(review);
    const responses = await Promise.all([approve(review, data), approve(review, data)]);
    expect(responses.map(item => item.status).sort()).toEqual([202, 409]);
    const result = await settled(f.workflow, review);
    expect(result.status).toBe("succeeded");
    expect("result" in result && result.result).toMatchObject({ applicationId: "application-1", manifestHash: prepared.manifestHash, status: "submitted" });
    expect(f.gateway.writes.submit).toBe(1);
    expect(data.manifestHash).toBe(prepared.manifestHash);
    expect(f.gateway.submitted?.manifest).toEqual(prepared.manifest);
    expect(f.gateway.submitted?.files.get("letter")?.sha256).toBe(prepared.manifest.documents[1]?.file?.sha256);
    expect((await approve(review, data)).status).toBe(409);
    expect(f.gateway.writes.submit).toBe(1);
  });

  test.each(["file", "account", "schema", "resume"])("changed %s invalidates approval before any remote mutation", async change => {
    const f = await fixture();
    const prepared = await prepare(f.workflow, f.input);
    const review = await f.workflow.submitApplication(prepared.draftId);
    if (change === "file") await pdf(f.path, "Changed attachment");
    if (change === "account") f.gateway.accountKey = "b".repeat(64);
    if (change === "schema") f.gateway.form.version = "v2";
    if (change === "resume") f.gateway.documents[0]!.revision = "d".repeat(64);
    expect((await approve(review)).status).toBe(202);
    expect((await settled(f.workflow, review)).status).toBe("invalidated");
    expect(f.gateway.writes).toEqual({ submit: 0, upload: 0, defaults: 0 });
  });

  test("expired reviews and closed workflows never mutate", async () => {
    let now = 0;
    const f = await fixture(new ReviewService({ now: () => now }));
    const prepared = await prepare(f.workflow, f.input);
    const review = await f.workflow.submitApplication(prepared.draftId);
    const body = await snapshot(review);
    now = 15 * 60_000;
    expect((await approve(review, body)).status).toBe(409);
    expect(f.workflow.getOperationStatus(review.operationId).status).toBe("expired");
    const second = await f.workflow.submitApplication((await prepare(f.workflow, f.input)).draftId);
    await f.workflow.close();
    expect(f.workflow.getOperationStatus(second.operationId).status).toBe("invalidated");
    expect(f.gateway.writes.submit).toBe(0);
  });

  test.each([false, true])("proven pre-write logout releases the account and permits a separately approved retry: boundary %s", async boundary => {
    const f = await fixture();
    const original = f.gateway.submitApplication.bind(f.gateway);
    f.gateway.submitApplication = async (_manifest, _files, beforeSubmit) => {
      if (boundary) beforeSubmit();
      throw new ReviewBeforeMutationError("Logged out before transport write", undefined, "authentication_expired");
    };
    const review = await f.workflow.submitApplication((await prepare(f.workflow, f.input)).draftId);
    const decision = await snapshot(review);
    await approve(review, decision);
    expect((await settled(f.workflow, review)).status).toBe("failed");
    expect(f.gateway.writes.submit).toBe(0);
    const ledger = new AttemptLedger(f.ledgerPath);
    const failed = ledger.get(review.operationId)!;
    expect(failed.state).toBe("failed");
    expect(failed.noRemoteMutation).toBe(1);
    const reopened = new ApplicationWorkflow({ ...f.options, reviews: new ReviewService() });
    workflows.push(reopened);
    expect(reopened.getOperationStatus(review.operationId)).toMatchObject({ status: "failed", result: { code: "no_remote_mutation" } });
    // A new approval is mandatory: the consumed review cannot authorize any retry.
    expect((await approve(review, decision)).status).toBe(409);
    f.gateway.submitApplication = original;
    const retry = await f.workflow.submitApplication((await prepare(f.workflow, f.input)).draftId);
    expect(f.gateway.writes.submit).toBe(0);
    await approve(retry);
    expect((await settled(f.workflow, retry)).status).toBe("succeeded");
    expect(f.gateway.writes.submit).toBe(1);
    expect(ledger.get(review.operationId)).toEqual(failed);
    ledger.close();
  });

  test("uncertain writes are durable, never retried, and do not disclose transport credentials", async () => {
    const f = await fixture();
    const secret = "WW_SESSION=secret-cookie-value";
    f.gateway.submitError = new Error(`Upstream response contained ${secret}`);
    const review = await f.workflow.submitApplication((await prepare(f.workflow, f.input)).draftId);
    expect((await approve(review)).status).toBe(202);
    const result = await settled(f.workflow, review);
    expect(result.status).toBe("outcome_unknown");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(await snapshot(review))).not.toContain(secret);
    expect(f.gateway.writes.submit).toBe(1);
    const ledger = new AttemptLedger(f.ledgerPath);
    expect(ledger.get(review.operationId)?.state).toBe("outcome_unknown");
    ledger.close();
    await f.workflow.close();
    const reopenedReviews = new ReviewService();
    services.push(reopenedReviews);
    const reopened = new ApplicationWorkflow({ ...f.options, reviews: reopenedReviews });
    workflows.push(reopened);
    expect(reopened.getOperationStatus(review.operationId).status).toBe("outcome_unknown");
    f.gateway.submitError = undefined;
    const retry = await reopened.submitApplication((await prepare(reopened, f.input)).draftId);
    expect((await approve(retry)).status).toBe(202);
    expect((await settled(reopened, retry)).status).toBe("failed");
    expect(f.gateway.writes.submit).toBe(1);
  });

  test("mismatched successful receipts remain uncertain", async () => {
    const f = await fixture();
    f.gateway.receiptHash = "f".repeat(64);
    const review = await f.workflow.submitApplication((await prepare(f.workflow, f.input)).draftId);
    expect((await approve(review)).status).toBe(202);
    expect((await settled(f.workflow, review)).status).toBe("outcome_unknown");
    expect(f.gateway.writes.submit).toBe(1);
  });

  test("unsupported write capability fails before creating an approval or mutation", async () => {
    const f = await fixture();
    f.gateway.capabilities.submit = false;
    const prepared = await prepare(f.workflow, f.input);
    await expect(f.workflow.submitApplication(prepared.draftId)).rejects.toThrow("no verified WaterlooWorks protocol");
    expect(f.gateway.writes.submit).toBe(0);
  });
});

describe("document approvals", () => {
  test("library uploads expose and separately confirm the exact processed PDF", async () => {
    const f = await fixture();
    const processed = await PDFDocument.create(); processed.addPage().drawText("Processed library PDF");
    const bytes = await processed.save();
    const document: LibraryDocument = { id: "202", typeId: "2", name: "Uploaded letter", revision: createHash("sha256").update(bytes).digest("hex"), state: "ready", source: "library" };
    const gateway = f.gateway as ApplicationGateway;
    gateway.uploadDocument = async () => { f.gateway.writes.upload++; return { ...document }; };
    gateway.getDocumentSnapshot = async () => ({ document: { ...document }, bytes });
    const first = await f.workflow.uploadDocument("2", "Uploaded letter", f.path);
    expect((await approve(first)).status).toBe(202);
    const status = await settled(f.workflow, first);
    expect(status.status).toBe("review_required");
    expect(f.gateway.writes.upload).toBe(1);
    const next = (status as { result: unknown }).result as CreatedReview;
    expect((await approve(next)).status).toBe(202);
    expect((await settled(f.workflow, next)).status).toBe("succeeded");
    expect(f.gateway.writes).toEqual({ submit: 0, upload: 1, defaults: 0 });
  });

  test("upload review binds the captured digest and performs one approved upload", async () => {
    const f = await fixture();
    const review = await f.workflow.uploadDocument("2", "Cover letter", f.path);
    expect(f.gateway.writes.upload).toBe(0);
    const data = await snapshot(review);
    expect(data.manifest.file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data.manifestHash).toBe(fingerprint(data.manifest));
    expect(JSON.stringify(data.manifest)).not.toContain(f.root);
    expect((await approve(review, data)).status).toBe(202);
    const result = await settled(f.workflow, review);
    expect(result.status).toBe("succeeded");
    expect("result" in result && result.result).toMatchObject({ revision: data.manifest.file.sha256, name: "Cover letter", state: "ready" });
    expect(f.gateway.uploaded?.sha256).toBe(data.manifest.file.sha256);
    expect(f.gateway.writes.upload).toBe(1);
    expect((await approve(review, data)).status).toBe(409);
  });

  test.each(["file", "account"])("upload revalidates changed %s before writing", async change => {
    const f = await fixture();
    const review = await f.workflow.uploadDocument("2", "Cover letter", f.path);
    if (change === "file") await pdf(f.path, "Changed upload");
    else f.gateway.accountKey = "b".repeat(64);
    expect((await approve(review)).status).toBe(202);
    expect((await settled(f.workflow, review)).status).toBe("invalidated");
    expect(f.gateway.writes.upload).toBe(0);
  });

  test("a recorded upload is recovered from the library, and an absent one unlocks after a delay", async () => {
    const f = await fixture();
    const sha = "e".repeat(64);
    const key = fingerprint(["upload", f.gateway.accountKey, "2", "Resume abc", sha]);
    const ledger = new AttemptLedger(f.ledgerPath);
    const clock = Date.now;
    try {
      Date.now = () => clock() - 180_000;
      ledger.reserve({ attemptId: "lost-upload", accountKey: f.gateway.accountKey, operationKey: key, manifestHash: "c".repeat(64), kind: "upload_document" });
      ledger.transition("lost-upload", "staging"); ledger.transition("lost-upload", "submitting"); ledger.transition("lost-upload", "succeeded", "201");
      Date.now = clock;
      const landed: LibraryDocument = { id: "201", typeId: "2", name: "Resume abc", revision: "d".repeat(64), state: "ready", source: "library" };
      f.gateway.documents.push(landed);
      expect(await f.workflow.recoverUpload("2", "Resume abc", sha)).toEqual(landed);
      expect(ledger.findOperation(key)).not.toBeNull();
      f.gateway.documents.push({ ...landed, id: "202" });
      await expect(f.workflow.recoverUpload("2", "Resume abc", sha)).rejects.toThrow("Several library documents");
      f.gateway.documents.splice(1);
      expect(await f.workflow.recoverUpload("2", "Resume abc", sha)).toBeUndefined();
      expect(ledger.findOperation(key)).toBeNull();
      expect(ledger.get("lost-upload")).toMatchObject({ state: "succeeded", retryAuthorizedAt: expect.any(Number) });
      expect(f.gateway.writes.upload).toBe(0);
    } finally { Date.now = clock; ledger.close(); }
  });

  test("a recent or in-flight upload stays locked when the document is absent", async () => {
    const f = await fixture();
    const sha = "e".repeat(64);
    const ledger = new AttemptLedger(f.ledgerPath);
    try {
      const key = fingerprint(["upload", f.gateway.accountKey, "2", "Resume abc", sha]);
      ledger.reserve({ attemptId: "running", accountKey: f.gateway.accountKey, operationKey: key, manifestHash: "c".repeat(64), kind: "upload_document" });
      ledger.transition("running", "staging");
      await expect(f.workflow.recoverUpload("2", "Resume abc", sha)).rejects.toThrow("still in progress");
      ledger.transition("running", "submitting"); ledger.transition("running", "outcome_unknown");
      await expect(f.workflow.recoverUpload("2", "Resume abc", sha)).rejects.toThrow("too recent");
      expect(ledger.findOperation(key)).not.toBeNull();
    } finally { ledger.close(); }
  });

  test("finished drafts free their capacity without waiting to expire", async () => {
    const f = await fixture();
    f.gateway.getApplicationStatus = async jobId => ({ jobId, hasApplication: false });
    for (let attempt = 0; attempt < 20; attempt++) {
      const review = await f.workflow.submitApplication((await prepare(f.workflow, { ...f.input, jobId: "123" })).draftId);
      expect((await approve(review)).status).toBe(202);
      await settled(f.workflow, review);
    }
    expect(f.gateway.writes.submit).toBe(1);
  });
});
