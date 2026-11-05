import { createHash, randomUUID } from "node:crypto";
import { authorizeApplicationRetry } from "./application-retry.js";
import { operationFailure } from "../../shared/src/operation-failure.js";
import { ReviewService, ReviewContinuation, ReviewBeforeMutationError, type CreatedReview, type JsonValue } from "../../approval/src/index.js";
import { AttemptConflictError, AttemptLedger } from "./ledger.js";
import { fingerprint } from "./fingerprint.js";
import { readApplicationPdf } from "./files.js";
import { validateApplication } from "./validate.js";
import type { ApplicationGateway, ApplicationInput, ApplicationManifest, PreparedFile, StagedAttachment } from "./types.js";

interface Draft {
  input: ApplicationInput;
  manifest: ApplicationManifest;
  files: Map<string, PreparedFile>;
  expiresAt: number;
  review?: CreatedReview;
}

export interface ApplicationWorkflowOptions {
  gateway: ApplicationGateway;
  documentRoots: string[];
  ledgerPath: string;
  reviews?: ReviewService;
}

/** Owns approval and recovery; adapters cannot be invoked by MCP without this boundary. */
export class ApplicationWorkflow {
  private readonly drafts = new Map<string, Draft>();
  private readonly pendingReviews = new Map<string, Promise<CreatedReview>>();
  private readonly reviews: ReviewService;
  private ledger: AttemptLedger | undefined;
  private closed = false;

  constructor(private readonly options: ApplicationWorkflowOptions) {
    this.reviews = options.reviews ?? new ReviewService();
  }

  get capabilities() { return { ...this.options.gateway.capabilities, approval: "localhost", documentRootsConfigured: this.options.documentRoots.length > 0 }; }
  listDocuments() { return this.options.gateway.listDocuments(); }
  getOperationProgress(operationId: string) { return this.options.gateway.getOperationProgress?.(operationId) ?? Promise.resolve(null); }
  watchOperationProgress(operationId:string,listener:(progress:import("../../shared/src/application-progress.js").ApplicationProgress)=>void):()=>void{return this.options.gateway.watchOperationProgress?.(operationId,listener)??(()=>{});}
  getApplicationForm(jobId: string) { return this.options.gateway.getApplicationForm(jobId); }

  async prepareApplication(input: ApplicationInput, executionMode: "submit" | "fill_only" = "submit") {
    this.prune();
    if (this.drafts.size >= 16) throw new Error("Too many prepared applications; wait for existing drafts to expire");
    const form = await this.options.gateway.getApplicationForm(input.jobId);
    if (form.blockers.length) return { status: "blocked", blockers: form.blockers };
    if (input.attachments.length > 8) throw new Error("Too many attachments");
    const files = new Map<string, PreparedFile>();
    for (const attachment of input.attachments) {
      if (files.has(attachment.requirementId)) throw new Error("Duplicate attachment slot");
      if (!form.requirements.some(slot => slot.id === attachment.requirementId && slot.role === "attachment")) throw new Error("Unknown attachment slot");
      files.set(attachment.requirementId, await readApplicationPdf(attachment.filePath, this.options.documentRoots));
    }
    const result = validateApplication(form, input, await this.selectedDocuments(input.resumeDocumentId), files);
    if (!result.manifest) return { status: "blocked", blockers: result.blockers };
    const totalBytes = [...files.values()].reduce((total, file) => total + file.size, 0)
      + [...this.drafts.values()].reduce((total, draft) => total + [...draft.files.values()].reduce((sum, file) => sum + file.size, 0), 0);
    if (totalBytes > 32_000_000) throw new Error("Prepared document memory limit reached");
    // Preparation awaits network/file reads; other concurrent requests may have filled capacity.
    if (this.drafts.size >= 16) throw new Error("Too many prepared applications; wait for existing drafts to expire");
    const draftId = randomUUID();
    const manifest = structuredClone(result.manifest);
    if (executionMode === "fill_only") manifest.executionMode = executionMode;
    this.drafts.set(draftId, { input: structuredClone(input), manifest, files, expiresAt: Date.now() + 15 * 60_000 });
    return { status: "prepared", draftId, manifest: structuredClone(manifest), manifestHash: fingerprint(manifest), blockers: [] };
  }

  submitApplication(draftId: string): Promise<CreatedReview> {
    const existing = this.pendingReviews.get(draftId);
    if (existing) return existing;
    const pending = this.requestApplicationReview(draftId);
    this.pendingReviews.set(draftId, pending);
    void pending.finally(() => this.pendingReviews.delete(draftId)).catch(() => undefined);
    return pending;
  }

  private async requestApplicationReview(draftId: string): Promise<CreatedReview> {
    this.requireCapability("submit");
    this.prune();
    const draft = this.drafts.get(draftId);
    if (!draft || draft.expiresAt <= Date.now()) throw new Error("Application draft is missing or expired; prepare it again");
    if (draft.review) return { ...draft.review };
    await this.revalidate(draft);
    draft.expiresAt = Date.now() + 15 * 60_000;
    const id = randomUUID();
    const hash = fingerprint(draft.manifest);
    const manifest = structuredClone(draft.manifest);
    draft.review = this.reviews.createReview({
      id, manifest: json(manifest), manifestHash: hash, actionLabel: draft.files.size && this.options.gateway.stageAttachments ? "Approve uploads, then review processed PDFs" : (manifest.executionMode === "fill_only" ? "Approve and fill form only" : "Approve and submit"),
      documents: [...draft.files].map(([requirementId, file]) => ({ id: requirementId, name: file.filename, bytes: file.bytes })),
      revalidate: () => this.revalidate(draft),
      execute: () => {
        if (draft.files.size && this.options.gateway.stageAttachments) return this.execute(id, manifest.accountKey, fingerprint(["stage_documents", manifest.accountKey, manifest.jobId, hash]), hash, "stage_application_documents", async ledger => {
          ledger.transition(id, "submitting");
          const staged = await this.options.gateway.stageAttachments!(structuredClone(manifest), cloneFiles(draft.files), id);
          const review = await this.reviewStagedApplication(draft, manifest, staged);
          ledger.transition(id, "succeeded");
          return new ReviewContinuation(review);
        });
        return this.execute(id, manifest.accountKey, fingerprint(["application", manifest.accountKey, manifest.jobId, manifest.term]), hash, "application", async ledger => {
        const receipt = await this.options.gateway.submitApplication(structuredClone(manifest), cloneFiles(draft.files), () => ledger.transition(id, "submitting"), undefined, id);
        if (ledger.get(id)?.state !== "submitting" || receipt.manifestHash !== hash || receipt.jobId !== manifest.jobId || (manifest.executionMode === "fill_only" ? receipt.status !== "form_filled" || receipt.applicationId !== "" : receipt.status !== "submitted" || !receipt.applicationId)) throw new Error("Submission receipt could not be verified");
        ledger.transition(id, "succeeded", receipt.applicationId || undefined);
        draft.files.clear();
        return { applicationId: receipt.applicationId, jobId: receipt.jobId, status: receipt.status, manifestHash: receipt.manifestHash, externalSteps: [...receipt.externalSteps] };
        });
      },
    });
    return { ...draft.review };
  }

  private async reviewStagedApplication(draft: Draft, source: ApplicationManifest, staged: StagedAttachment[]): Promise<CreatedReview> {
    if (!this.options.gateway.getDocumentSnapshot || staged.length !== source.documents.filter(item => item.file).length || new Set(staged.map(item => item.requirementId)).size !== staged.length) throw new Error("Staged attachment set cannot be verified");
    const manifest = structuredClone(source);
    const form = await this.options.gateway.getApplicationForm(source.jobId);
    for (const item of staged) {
      const slot = manifest.documents.find(doc => doc.requirementId === item.requirementId && doc.file);
      const type = form.requirements.find(doc => doc.id === item.requirementId && doc.role === "attachment")?.typeId;
      if (!slot || item.document.state !== "ready" || item.document.typeId !== type || item.document.revision !== createHash("sha256").update(item.bytes).digest("hex")) throw new Error("Staged PDF snapshot is invalid");
      slot.storedDocument = structuredClone(item.document);
    }
    draft.expiresAt = Date.now() + 15 * 60_000;
    const id = randomUUID(); const hash = fingerprint(manifest);
    return this.reviews.createReview({ id, manifest: json(manifest), manifestHash: hash, actionLabel: manifest.executionMode === "fill_only" ? "Approve processed PDFs and fill form only" : "Approve processed PDFs and submit",
      documents: staged.map(item => ({ id: item.requirementId, name: item.document.name, bytes: item.bytes })),
      revalidate: async () => {
        await this.revalidate(draft);
        for (const item of staged) {
          const fresh = await this.options.gateway.getDocumentSnapshot!(item.document.id);
          if (fingerprint(fresh.document) !== fingerprint(item.document) || createHash("sha256").update(fresh.bytes).digest("hex") !== item.document.revision) throw new Error("Processed PDF changed");
        }
      },
      execute: () => this.execute(id, manifest.accountKey, fingerprint(["application", manifest.accountKey, manifest.jobId, manifest.term]), hash, "application", async ledger => {
        const receipt = await this.options.gateway.submitApplication(structuredClone(manifest), cloneFiles(draft.files), () => ledger.transition(id, "submitting"), structuredClone(staged), id);
        if (ledger.get(id)?.state !== "submitting" || receipt.manifestHash !== hash || receipt.jobId !== manifest.jobId || (manifest.executionMode === "fill_only" ? receipt.status !== "form_filled" || receipt.applicationId !== "" : receipt.status !== "submitted" || !receipt.applicationId)) throw new Error("Submission receipt could not be verified");
        ledger.transition(id, "succeeded", receipt.applicationId || undefined); draft.files.clear();
        return { applicationId: receipt.applicationId, jobId: receipt.jobId, status: receipt.status, manifestHash: hash, externalSteps: [...receipt.externalSteps] };
      }),
    });
  }

  async uploadDocument(typeId: string, name: string, filePath: string): Promise<CreatedReview> {
    this.requireCapability("upload");
    if (!/^\d+$/.test(typeId) || !name.trim() || name.length > 255 || /[\x00-\x1f]/.test(name)) throw new Error("Invalid document type or name");
    const file = await readApplicationPdf(filePath, this.options.documentRoots);
    const account = await this.options.gateway.getAccount();
    const manifest = { kind: "upload_document", ...account, typeId, name, file: { filename: file.filename, size: file.size, sha256: file.sha256 } };
    const hash = fingerprint(manifest);
    const id = randomUUID();
    return this.reviews.createReview({
      id, manifest, manifestHash: hash, actionLabel: "Approve upload",
      documents: [{ id: "document", name: file.filename, bytes: file.bytes }],
      revalidate: async () => {
        await this.checkAccount(account.accountKey);
        if ((await readApplicationPdf(filePath, this.options.documentRoots)).sha256 !== file.sha256) throw new Error("File changed");
      },
      execute: () => this.execute(id, account.accountKey, fingerprint(["upload", account.accountKey, typeId, name, file.sha256]), hash, "upload_document", async ledger => {
        ledger.transition(id, "submitting");
        const document = await this.options.gateway.uploadDocument(typeId, name, { ...file, bytes: new Uint8Array(file.bytes) }, account.accountKey, id);
        if (document.typeId !== typeId || document.state !== "ready" || document.name !== name || (!this.options.gateway.getDocumentSnapshot && document.revision !== file.sha256)) throw new Error("Uploaded document could not be verified");
        if (this.options.gateway.getDocumentSnapshot) {
          const captured = await this.options.gateway.getDocumentSnapshot(document.id);
          if (fingerprint(captured.document) !== fingerprint(document) || createHash("sha256").update(captured.bytes).digest("hex") !== document.revision) throw new Error("Stored upload changed");
          const reviewId = randomUUID();
          const processedManifest = { kind: "processed_document", ...account, originalFile: manifest.file, documents: [document] };
          const review = this.reviews.createReview({ id: reviewId, manifest: json(processedManifest), manifestHash: fingerprint(processedManifest), actionLabel: "Confirm processed PDF",
            documents: [{ id: "processed", name: document.name, bytes: captured.bytes }],
            revalidate: async () => { await this.checkAccount(account.accountKey); if (fingerprint((await this.options.gateway.getDocumentSnapshot!(document.id)).document) !== fingerprint(document)) throw new Error("Processed PDF changed"); },
            execute: async () => ({ id: document.id, typeId: document.typeId, name: document.name, revision: document.revision, state: document.state, source: document.source }),
          });
          ledger.transition(id, "succeeded", document.id); file.bytes.fill(0);
          return new ReviewContinuation(review);
        }
        ledger.transition(id, "succeeded", document.id);
        file.bytes.fill(0);
        return { id: document.id, typeId: document.typeId, name: document.name, revision: document.revision, state: document.state, source: document.source };
      }),
    });
  }

  async setDefaultDocuments(typeId: string, documentIds: string[]): Promise<CreatedReview> {
    this.requireCapability("defaults");
    if (!/^\d+$/.test(typeId) || !documentIds.length || new Set(documentIds).size !== documentIds.length) throw new Error("Invalid default document selection");
    const account = await this.options.gateway.getAccount();
    const select = async () => {
      const docs = await this.options.gateway.listDocuments();
      return Promise.all(documentIds.map(id => {
        const doc = docs.find(item => item.id === id && item.typeId === typeId && item.state === "ready" && item.source === "library");
        if (!doc) throw new Error("Selected default document is not available");
        return this.options.gateway.getDocument ? this.options.gateway.getDocument(doc.id) : doc;
      }));
    };
    const documents = await select();
    const manifest = { kind: "set_default_documents", ...account, typeId, documents };
    const hash = fingerprint(manifest);
    const id = randomUUID();
    return this.reviews.createReview({
      id, manifest: json(manifest), manifestHash: hash, actionLabel: "Approve default change",
      revalidate: async () => {
        await this.checkAccount(account.accountKey);
        if (fingerprint(await select()) !== fingerprint(documents)) throw new Error("Default selection changed");
      },
      execute: () => this.execute(id, account.accountKey, fingerprint(["defaults", account.accountKey, id]), hash, "set_default_documents", async ledger => {
        ledger.transition(id, "submitting");
        const result = await this.options.gateway.setDefaultDocuments(typeId, [...documentIds], account.accountKey);
        if (fingerprint(result.documentIds) !== fingerprint(documentIds)) throw new Error("Defaults could not be verified");
        ledger.transition(id, "succeeded");
        return { documentIds: [...result.documentIds] };
      }),
    });
  }

  async getApplicationStatus(jobId: string, expectedAccountKey?: string) {
    if (expectedAccountKey) await this.checkAccount(expectedAccountKey);
    const status = await this.options.gateway.getApplicationStatus(jobId);
    if (expectedAccountKey) await this.checkAccount(expectedAccountKey);
    if (status.jobId !== jobId) throw new Error("Application status belongs to another posting");
    return status;
  }
  async listApplications() {
    if (!this.options.gateway.listApplications) throw new Error("Applications inventory is unavailable");
    return this.options.gateway.listApplications();
  }

  /** Reconcile only reads; absence releases the account block, never the posting's replay lock. */
  async reconcileApplication(jobId: string, term: string, inventory: import("./types.js").ApplicationInventory) {
    await this.checkAccount(inventory.accountKey);
    if (Date.now() - Date.parse(inventory.checkedAt) > 60_000 || Date.parse(inventory.checkedAt) > Date.now() + 5_000 || !Number.isFinite(Date.parse(inventory.checkedAt))) throw new Error("Application inventory is stale");
    const status = await this.getApplicationStatus(jobId);
    await this.checkAccount(inventory.accountKey);
    const record = inventory.applications.find(item => item.jobId === jobId && item.term === term && item.status === "Applied");
    const ledger = this.getLedger();
    const attempt = ledger.findOperation(fingerprint(["application", inventory.accountKey, jobId, term]));
    if (attempt && Date.now() - attempt.updatedAt >= 120_000 && ["submitting", "outcome_unknown"].includes(attempt.state)) {
      if (attempt.state === "submitting") ledger.transition(attempt.attemptId, "outcome_unknown");
      if (status.hasApplication && record && Date.parse(record.submittedAt) >= attempt.createdAt - 2000) {
        ledger.transition(attempt.attemptId, "succeeded", record.applicationId);
      } else if (!status.hasApplication && !record && attempt.accountReleasedAt === null) {
        // Transitioning a stale submitting record updates its timestamp; wait for the next check.
        if (attempt.state === "outcome_unknown") ledger.releaseAccountQuarantine(attempt.attemptId, {
          accountKey: inventory.accountKey, jobId, checkedAt: Date.now(), hasApplication: false,
          reason: "Complete applications inventory and posting status both report no submitted application; no automatic replay",
        });
      }
    }
    return status;
  }

  getBlockingAttempts() { return this.getLedger().listAccountBlocks(); }

  /** A verified fill-only receipt has no application ID. Absence permits a new human approval, never an automatic write. */
  async reconcileFilledApplication(jobId: string, term: string, inventory: import("./types.js").ApplicationInventory) {
    const status = await this.reconcileApplication(jobId, term, inventory);
    if (status.hasApplication) return status;
    if (inventory.applications.some(item => item.jobId === jobId)) throw new Error("Application inventory conflicts with posting absence; the filled form remains pending");
    const ledger = this.getLedger();
    const attempts = ledger.recoveryAttempts(inventory.accountKey, jobId, term);
    if (attempts.length) {
      if (!attempts.some(attempt => attempt.kind === "application" && attempt.state === "succeeded" && attempt.receiptId === null)) throw new Error("No verified filled-form completion is available");
      ledger.authorizeApplicationRetries(attempts, { accountKey: inventory.accountKey, jobId, term, checkedAt: Date.parse(inventory.checkedAt), inventoryChecked: true }, "filled_form_check");
    }
    return status;
  }

  /** Human dashboard only: verifies absence, retains history, requires a new submission approval. */
  authorizeApplicationRetry(jobId: string, term: string) {
    return authorizeApplicationRetry(this.options.gateway, this.getLedger(), jobId, term, id => this.reviews.getStatus(id)?.status === "executing");
  }

  /** Exposed only by the human dashboard, never by an agent-facing tool. */
  releaseSubmissionBlock(attemptId: string, expectedUpdatedAt: number, reason: string) {
    if (this.reviews.getStatus(attemptId)?.status === "executing") throw new Error("This operation is still executing");
    return this.getLedger().releaseAccountBlockManually(attemptId, expectedUpdatedAt, reason);
  }

  getOperationStatus(id: string) {
    const live = this.reviews.getStatus(id);
    if (this.closed && live) return live;
    const events = this.getLedger().events(id);
    const diagnostics = events.length ? { events } : {};
    if (live && live.status !== "outcome_unknown") return { ...live, ...diagnostics };
    const durable = this.getLedger().get(id);
    if (live && durable?.state !== "succeeded") return { ...live, ...diagnostics };
    if (!durable) throw new Error("Unknown operation ID");
    return { operationId: id, status: ["reserved", "staging", "submitting"].includes(durable.state) ? "outcome_unknown" : durable.state,
      ...diagnostics,
      ...(durable.receiptId ? { receiptId: durable.receiptId } : {}),
      ...(durable.state === "failed" && durable.noRemoteMutation === 1 ? { result: { code: "no_remote_mutation" } } : {}) };
  }

  async close(): Promise<void> {
    await this.reviews.close();
    this.drafts.clear();
    this.ledger?.close();
    this.closed = true;
  }

  private getLedger(): AttemptLedger { return this.ledger ??= new AttemptLedger(this.options.ledgerPath); }

  private async execute<T>(id: string, accountKey: string, operationKey: string, hash: string, kind: string, action: (ledger: AttemptLedger) => Promise<T>): Promise<T> {
    let ledger: AttemptLedger;
    try {
      ledger = this.getLedger();
      ledger.reserve({ attemptId: id, accountKey, operationKey, manifestHash: hash, kind });
      ledger.transition(id, "staging");
    } catch (error) {
      if (error instanceof AttemptConflictError) throw new ReviewBeforeMutationError("Another operation must be resolved before this one can run", { operationId: error.attempt.attemptId, state: error.attempt.state });
      throw new ReviewBeforeMutationError("The local operation ledger could not be opened or reserved");
    }
    try { return await (this.options.gateway.withMutationTracking ? this.options.gateway.withMutationTracking(() => action(ledger)) : action(ledger)); }
    catch (error) {
      const failure = error instanceof ReviewBeforeMutationError && error.failure ? error.failure
        : operationFailure(error, "transport", !(error instanceof ReviewBeforeMutationError));
      ledger.recordEvent(id, "operation_failed", failure);
      console.error(JSON.stringify({ event: "application.operation_failed", operationId: id, kind, ...failure }));
      const state = ledger.get(id)?.state;
      if (state === "staging" || state === "submitting") {
        if (error instanceof ReviewBeforeMutationError) ledger.failBeforeMutation(id, error);
        else ledger.transition(id, "outcome_unknown");
      }
      throw error;
    }
  }

  private async checkAccount(expected: string) {
    if ((await this.options.gateway.getAccount()).accountKey !== expected) throw new Error("WaterlooWorks account changed");
  }

  private async revalidate(draft: Draft): Promise<void> {
    if (draft.expiresAt <= Date.now()) throw new Error("Application draft expired");
    await this.checkAccount(draft.manifest.accountKey);
    for (const attachment of draft.input.attachments) {
      if ((await readApplicationPdf(attachment.filePath, this.options.documentRoots)).sha256 !== draft.files.get(attachment.requirementId)?.sha256) throw new Error("Application file changed");
    }
    const form = await this.options.gateway.getApplicationForm(draft.input.jobId);
    const fresh = validateApplication(form, draft.input, await this.selectedDocuments(draft.input.resumeDocumentId), draft.files);
    if (fresh.manifest && draft.manifest.executionMode) fresh.manifest.executionMode = draft.manifest.executionMode;
    if (!fresh.manifest || fingerprint(fresh.manifest) !== fingerprint(draft.manifest)) throw new Error("Application changed; prepare a new review");
  }

  private async selectedDocuments(resumeId: string) {
    if (this.options.gateway.getDocument) return [await this.options.gateway.getDocument(resumeId)];
    return this.options.gateway.listDocuments();
  }

  private prune(): void {
    for (const [id, draft] of this.drafts) if (draft.expiresAt <= Date.now() && (!draft.review || this.reviews.getStatus(draft.review.operationId)?.status !== "executing")) this.drafts.delete(id);
  }

  private requireCapability(kind: "submit" | "upload" | "defaults") {
    if (!this.options.gateway.capabilities[kind]) throw new Error(this.options.gateway.capabilities.reason ?? "This operation has no verified WaterlooWorks protocol");
  }
}

function cloneFiles(files: Map<string, PreparedFile>): Map<string, PreparedFile> {
  return new Map([...files].map(([id, file]) => [id, { ...file, bytes: new Uint8Array(file.bytes) }]));
}

function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
