import { withSubmissionBinding } from "../../bridge/src/submission-binding.js";
import type { ApprovedSnapshot } from "../../workspace/src/approved-snapshot.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ReviewService, ReviewStatus } from "../../approval/src/index.js";
import type { ApplicationWorkflow } from "../../application-workflow/src/workflow.js";
import { formatJobKey, type JobKey } from "../../workspace/src/paths.js";
import { planBlockers, toApplicationInput } from "../../workspace/src/plans.js";
import type { JobStatus } from "../../workspace/src/schemas.js";
import type { Workspace } from "../../workspace/src/store.js";
import { operationFailureSchema } from "../../shared/src/operation-failure.js";
import { applicationProgressSchema, progressLabel } from "../../shared/src/application-progress.js";

const TERMINAL = new Set(["review_required", "expired", "invalidated", "failed", "succeeded", "outcome_unknown"]);

/**
 * Runs applications that the user approved by clicking in the dashboard.
 * Every write still goes through ApplicationWorkflow (revalidation, ledger,
 * no automatic retry); the dashboard click replaces the separate review page.
 */
export class Applier {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  private readonly listeners=new Set<()=>void>();

  constructor(private readonly workspace: Workspace, private readonly workflow: ApplicationWorkflow, private readonly reviews: ReviewService) {}

  get hasActive(): boolean { return this.active.size > 0; }
  subscribe(listener:()=>void):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  private changed():void {for(const listener of this.listeners)try{listener();}catch{/* Display observers cannot affect submission. */}}
  private async setStatus(...args:Parameters<Workspace["setStatus"]>):Promise<JobStatus>{
    const status=await this.workspace.setStatus(...args);this.changed();return status;
  }

  isActive(key: JobKey): boolean { return this.active.has(formatJobKey(key)); }

  /** Applications run one at a time, in click order. */
  enqueue(key: JobKey, work: (key: JobKey) => Promise<unknown>): void {
    const id = formatJobKey(key);
    if (this.active.has(id)) return;
    this.active.add(id);
    this.changed();
    this.queue = this.queue.then(() => work(key)).catch(async error => {
      await this.setStatus(key, { state: "failed", reason: error instanceof Error ? error.message : "Application failed" }).catch(() => undefined);
    }).finally(() => {this.active.delete(id);this.changed();});
  }

  async apply(key: JobKey, snapshot?: ApprovedSnapshot, executionMode: "submit" | "fill_only" = "submit", submissionBinding?: string, approval?: string): Promise<void> {
    try { await withSubmissionBinding(submissionBinding,()=>this.applyPlan(key,snapshot,executionMode,approval)); }
    finally { await snapshot?.dispose().catch(() => undefined); }
  }
  private async applyPlan(key: JobKey, snapshot: ApprovedSnapshot | undefined, executionMode: "submit" | "fill_only", approval?: string): Promise<void> {
    const status = await this.workspace.getStatus(key);
    if (status?.state !== "ready" && status?.state !== "failed") throw new Error(`Job is ${status?.state ?? "unknown"}`);
    // A preceding uncertain write quarantines the account. Queued jobs have
    // not started and must retain their status and require a fresh user click.
    const savedForm = await this.workspace.getForm(key);
    if (this.workflow.getBlockingAttempts().some(attempt => !savedForm || attempt.accountKey === savedForm.accountKey)) return;
    const plan = snapshot?.plan ?? await this.workspace.getPlan(key);
    if (!plan) throw new Error("Job has no application plan");
    await this.setStatus(key, { state: "applying", reason: "Checking the application form" });

    const form = await this.workflow.getApplicationForm(key.jobId);
    await this.workspace.saveForm(key, form);
    if (snapshot && form.version !== snapshot.formVersion) {
      await this.setStatus(key, { state: "planned", reason: "The application form changed after you reviewed it. Nothing was submitted.", blockers: ["The application form changed; check this job's preparation and review it again"] });
      return;
    }
    const blockers = await planBlockers(this.workspace, key, plan, form, snapshot?.resumePath);
    if (blockers.length) {
      await this.setStatus(key, { state: "planned", reason: "Application preparation is incomplete; fix the listed requirements before applying", blockers });
      return;
    }
    const resumeSlot = form.requirements.find(slot => slot.role === "resume");
    if (!resumeSlot) return void await this.fail(key, "The application form has no resume slot");

    await this.setStatus(key, { state: "applying", reason: "Checking the resume" });
    const resumeId = await this.ensureResume(key, plan.resumeVariant, resumeSlot.typeId, snapshot?.resumePath, approval);

    await this.setStatus(key, { state: "applying", reason: executionMode === "fill_only" ? "Preparing to fill the form" : "Preparing the application" });
    const prepared = await this.workflow.prepareApplication(toApplicationInput(this.workspace, key, plan, resumeId), executionMode, approval);
    if (prepared.status !== "prepared" || !("draftId" in prepared)) return void await this.fail(key, "Application is blocked", prepared.blockers);
    const created = await this.workflow.submitApplication(prepared.draftId);
    await this.settle(key, await this.approve(created.operationId, manifest => manifest.kind === "application" && manifest.jobId === key.jobId, key));
  }

  /** Upload a resume variant once per content hash and remember its WaterlooWorks document ID. */
  private async ensureResume(key:JobKey, variant: string, typeId: string, frozenPdf?: string, approval?: string): Promise<string> {
    const pdf = frozenPdf ?? this.workspace.paths.resume(variant).pdf;
    const sha256 = createHash("sha256").update(await readFile(pdf)).digest("hex");
    const known = (await this.workspace.getResumeUploads(variant)).uploads.find(item => item.source === "waterlooworks" && item.sha256 === sha256);
    if (known) {
      const library = await this.workflow.listDocuments();
      if (library.some(doc => doc.id === known.documentId && doc.state === "ready" && doc.typeId === typeId)) return known.documentId;
    }
    const label = (await this.workspace.getResumeVariant(variant))?.label ?? variant;
    const name = `${label} ${sha256.slice(0, 8)}`.slice(0, 255);
    const recovered = await this.workflow.recoverUpload(typeId, name, sha256);
    if (recovered) {
      await this.workspace.recordResumeUpload(variant, { source: "waterlooworks", sha256, documentId: recovered.id, name, uploadedAt: new Date().toISOString() });
      return recovered.id;
    }
    await this.setStatus(key, {state:"applying",reason:"Preparing resume upload"});
    const created = await this.workflow.uploadDocument(typeId, name, pdf, approval);
    let state = await this.approve(created.operationId, manifest => manifest.kind === "upload_document", key);
    // The processed PDF is the user's own generated resume; confirm it as part of the same click.
    if (state.status === "review_required") state = await this.approve(operationOf(state), manifest => manifest.kind === "processed_document", key);
    const documentId = state.status === "succeeded" ? (state.result as { id?: unknown } | undefined)?.id : undefined;
    if (typeof documentId !== "string") throw new Error(`Resume upload did not complete (${state.status}). ${failureReason(state)}`);
    await this.workspace.recordResumeUpload(variant, { source: "waterlooworks", sha256, documentId, name, uploadedAt: new Date().toISOString() });
    return documentId;
  }

  private async approve(operationId: string, expected: (manifest: Record<string, unknown>) => boolean, key:JobKey): Promise<ReviewStatus> {
    const review = this.reviews.inspect(operationId);
    if (!review || review.status !== "awaiting_approval") throw new Error("The operation is no longer awaiting approval");
    if (!expected(review.manifest as Record<string, unknown>)) throw new Error("The prepared operation does not match this job");
    let lastProgress = "", updates=Promise.resolve();
    const stop=this.workflow.watchOperationProgress(operationId,progress=>{
      updates=updates.then(async()=>{
        const parsed=applicationProgressSchema.safeParse(progress);
        const current=this.reviews.getStatus(operationId);
        if(!parsed.success || !current || TERMINAL.has(current.status))return;
        const reason=progressLabel(parsed.data);
        if(reason===lastProgress)return;
        const saved=await this.workspace.getStatus(key);
        if(saved?.state==="applying")await this.setStatus(key,{...saved,reason});
        lastProgress=reason;
      }).catch(()=>{});
    });
    try {
      if (!this.reviews.approve(operationId, review.manifestHash)) throw new Error("The operation could not be approved");
      for (;;) {
        const status = this.reviews.getStatus(operationId);
        if (!status) throw new Error("The operation disappeared");
        if (TERMINAL.has(status.status)) return status;
        await Bun.sleep(250);
      }
    }finally{stop();await updates;}
  }

  private async settle(key: JobKey, state: ReviewStatus): Promise<void> {
    const result = state.result as Record<string, unknown> | undefined;
    switch (state.status) {
      case "succeeded":
        await this.setStatus(key, {
          state: result?.status === "form_filled" ? "form_filled" : "applied", reason: result?.status === "form_filled" ? "Form filled. Click Submit in the open WaterlooWorks tab. We’ll check after two minutes and return this job to Ready to apply if it was not submitted." : "Submitted", ...(typeof result?.applicationId === "string" && result.applicationId ? { applicationId: result.applicationId } : {}),
          externalSteps: Array.isArray(result?.externalSteps) ? result.externalSteps.map(String) : [],
        });
        return;
      case "review_required": {
        // The original Apply click covers the verified, server-processed PDFs (docs/protocol.md).
        const operationId = operationOf(state);
        const review = this.reviews.inspect(operationId);
        if (!review) throw new Error("Processed-document review is unavailable");
        await this.setStatus(key, { state: "applying", reason: "Verifying processed documents" });
        await this.settle(key, await this.approve(operationId, manifest => manifest.kind === "application" && manifest.jobId === key.jobId, key));
        return;
      }
      case "outcome_unknown":
        await this.setStatus(key, { state: "outcome_unknown", reason: `The operation outcome is unknown. Check WaterlooWorks before another attempt. ${diagnosticReason(state)}` });
        return;
      default:
        await this.fail(key, failureReason(state));
    }
  }

  private async fail(key: JobKey, reason: string, blockers: string[] = []): Promise<JobStatus> {
    return this.setStatus(key, { state: "failed", reason, blockers });
  }
}

function operationOf(state: ReviewStatus): string {
  const id = (state.result as { operationId?: unknown } | undefined)?.operationId;
  if (typeof id !== "string") throw new Error("Follow-up review is missing");
  return id;
}

function failureReason(state: ReviewStatus): string {
  const code = (state.result as { code?: unknown } | undefined)?.code;
  if (code === "no_remote_mutation") return `Stopped before a remote write; review and approve a new attempt. ${diagnosticReason(state)}`;
  if (code === "authentication_expired") return "WaterlooWorks signed out. Sign in again in your browser, then retry. Nothing was submitted.";
  if (code === "blocked_by_previous_attempt") return "An earlier attempt for this job must be resolved first. Check WaterlooWorks.";
  if (state.status === "invalidated") return "The application changed while it was being checked. Retry to use the latest form.";
  return `Application did not complete (${state.status}${typeof code === "string" ? `: ${code}` : ""}). Nothing was submitted.`;
}

function diagnosticReason(state: ReviewStatus): string {
  const parsed = operationFailureSchema.safeParse((state.result as { failure?: unknown } | undefined)?.failure);
  return `${parsed.success ? `${parsed.data.phase}: ${parsed.data.message}. ` : ""}Operation ${state.operationId}.`;
}
