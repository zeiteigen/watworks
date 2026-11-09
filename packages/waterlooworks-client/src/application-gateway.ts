import type { WaterlooWorksSession } from "../../shared/src/protocol.js";
import type { ApplicationForm, ApplicationGateway, ApplicationInput, ApplicationManifest, LibraryDocument, PreparedFile, StagedAttachment, SubmissionReceipt } from "../../application-workflow/src/types.js";
import { fingerprint } from "../../application-workflow/src/fingerprint.js";
import { validateApplication } from "../../application-workflow/src/validate.js";
import { ApplicationHttp, APPLICATION_PATH } from "./application-http.js";
import { ApplicationDocuments, type DocumentContext } from "./application-documents.js";
import { parseApplicationPage, type ParsedApplicationPage } from "./application-page.js";
import { pinSystemDocument } from "./system-document.js";
import { discoverPageAction, parseBootstrapPage, requirePostingAction } from "./bootstrap.js";
import { fieldsRecord, jsonObject, text } from "./application-fields.js";
import { applicationDeadline } from "./application-deadline.js";
import { normalizeJobPosting } from "./normalize.js";
import { ProtocolChangedError } from "./errors.js";
import type { SessionProvider, FetchLike } from "./session.js";

interface CurrentApplication {
  context: DocumentContext;
  page: ParsedApplicationPage;
  form: ApplicationForm;
  dataAction: string;
}

/** Full-cycle only. All mutations are invoked exclusively by the approved workflow. */
export class WaterlooWorksApplicationGateway implements ApplicationGateway {
  readonly capabilities = { upload: true, defaults: true, submit: true };
  private readonly http: ApplicationHttp;
  private readonly documents: ApplicationDocuments;

  constructor(provider: SessionProvider, fetchImpl?: FetchLike) {
    this.http = new ApplicationHttp(provider, fetchImpl);
    this.documents = new ApplicationDocuments(this.http);
  }

  withMutationTracking<T>(operation: () => Promise<T>): Promise<T> { return this.http.withMutationTracking(operation); }

  async getAccount() {
    const { accountKey, accountLabel } = await this.documents.context();
    return { accountKey, accountLabel };
  }

  async listDocuments(): Promise<LibraryDocument[]> { return this.documents.inventory(await this.documents.context()); }

  async getDocument(documentId: string): Promise<LibraryDocument> {
    if (!/^\d+$/.test(documentId)) throw new ProtocolChangedError("Invalid document identifier");
    const context = await this.documents.context();
    const document = (await this.documents.inventory(context)).find(item => item.id === documentId);
    if (!document) throw new ProtocolChangedError("Selected document is no longer in the library");
    return this.documents.read(context, document);
  }

  async getDocumentSnapshot(documentId: string) {
    if (!/^\d+$/.test(documentId)) throw new ProtocolChangedError("Invalid document identifier");
    const context = await this.documents.context();
    const document = (await this.documents.inventory(context)).find(item => item.id === documentId);
    if (!document) throw new ProtocolChangedError("Selected document disappeared");
    return this.documents.snapshot(context, document);
  }

  async stageAttachments(manifest: ApplicationManifest, files: ReadonlyMap<string, PreparedFile>): Promise<StagedAttachment[]> {
    if (manifest.executionMode === "fill_only") throw new Error("Fill-only applications require the browser extension");
    const current = await this.current(manifest.jobId, manifest.accountKey);
    const resume = manifest.documents.find(item => current.form.requirements.some(slot => slot.id === item.requirementId && slot.role === "resume"))?.document;
    if (!resume) throw new ProtocolChangedError("Explicit resume missing");
    const verifiedResume = await this.getDocument(resume.id);
    const input: ApplicationInput = { jobId: manifest.jobId, resumeDocumentId: resume.id,
      attachments: manifest.documents.filter(item => item.file).map(item => ({ requirementId: item.requirementId, filePath: "approved-snapshot" })),
      answers: manifest.answers.map(item => ({ questionId: item.questionId, value: structuredClone(item.value) })) };
    const validation = validateApplication(current.form, input, [verifiedResume], files);
    if (!validation.manifest || fingerprint(validation.manifest) !== fingerprint(manifest)) throw new ProtocolChangedError("Application changed before staging");
    const result: StagedAttachment[] = [];
    for (const item of manifest.documents.filter(item => item.file)) {
      const file = files.get(item.requirementId); const slot = current.form.requirements.find(slot => slot.id === item.requirementId);
      if (!file || !slot) throw new ProtocolChangedError("Missing approved attachment");
      const uploaded = await this.uploadAttachment(current, slot.typeId, file, false);
      const snapshot = await this.getDocumentSnapshot(uploaded.id);
      result.push({ requirementId: item.requirementId, ...snapshot });
    }
    return result;
  }

  async getApplicationForm(jobId: string): Promise<ApplicationForm> { return (await this.current(jobId)).form; }

  async uploadDocument(typeId: string, name: string, file: PreparedFile, accountKey: string): Promise<LibraryDocument> {
    return this.documents.upload(await this.documents.context(accountKey), typeId, name, file, true);
  }

  async setDefaultDocuments(typeId: string, documentIds: string[], accountKey: string) {
    return this.documents.defaults(await this.documents.context(accountKey), typeId, documentIds);
  }

  async getApplicationStatus(jobId: string) {
    checkJobId(jobId);
    const session = await this.http.session();
    const bootstrap = parseBootstrapPage(await this.http.read(session, APPLICATION_PATH));
    const data = jsonObject(await this.http.read(session, APPLICATION_PATH, new URLSearchParams({ action: requirePostingAction(bootstrap, "data"), postingId: jobId })));
    const application = data.applicationData;
    if (!application || typeof application !== "object" || typeof (application as Record<string, unknown>).hasApplication !== "boolean") throw new ProtocolChangedError("Application status is unavailable");
    return { jobId, hasApplication: (application as { hasApplication: boolean }).hasApplication };
  }

  async submitApplication(manifest: ApplicationManifest, files: ReadonlyMap<string, PreparedFile>, beforeFinalSubmit: () => void, staged?: readonly StagedAttachment[]): Promise<SubmissionReceipt> {
    if (manifest.executionMode === "fill_only") throw new Error("Fill-only applications require the browser extension");
    const current = await this.current(manifest.jobId, manifest.accountKey);
    const resume = manifest.documents.find(item => item.document?.source === "library" && current.form.requirements.some(slot => slot.id === item.requirementId && slot.role === "resume"))?.document;
    if (!resume) throw new ProtocolChangedError("Application has no explicit resume");
    const inventory = await this.documents.inventory(current.context);
    const libraryResume = inventory.find(item => item.id === resume.id);
    if (!libraryResume) throw new ProtocolChangedError("Selected resume disappeared");
    const verifiedResume = await this.documents.read(current.context, libraryResume);
    const input: ApplicationInput = { jobId: manifest.jobId, resumeDocumentId: resume.id,
      attachments: manifest.documents.filter(item => item.file).map(item => ({ requirementId: item.requirementId, filePath: "approved-snapshot" })),
      answers: manifest.answers.map(item => ({ questionId: item.questionId, value: structuredClone(item.value) })) };
    const validation = validateApplication(current.form, input, [verifiedResume], files);
    const sourceManifest = structuredClone(manifest);
    for (const item of sourceManifest.documents) delete item.storedDocument;
    if (!validation.manifest || fingerprint(validation.manifest) !== fingerprint(sourceManifest)) throw new ProtocolChangedError("Application no longer matches its approved manifest");
    if (staged && (staged.length !== manifest.documents.filter(item => item.file).length || new Set(staged.map(item => item.requirementId)).size !== staged.length)) throw new ProtocolChangedError("Staged document set changed");
    const fields = new URLSearchParams({ ...current.page.privateFields, action: current.page.submitAction, applyOption: "customPkg", name: current.page.packageName });
    for (const item of manifest.documents) {
      if (item.document) fields.set(item.requirementId, item.document.id);
      else if (item.file) {
        const file = files.get(item.requirementId);
        const slot = current.form.requirements.find(requirement => requirement.id === item.requirementId);
        if (!file || !slot || fingerprint({ filename: file.filename, size: file.size, sha256: file.sha256 }) !== fingerprint(item.file)) throw new ProtocolChangedError("Attachment differs from approved file");
        if (staged) {
          const approved = staged.find(doc => doc.requirementId === item.requirementId);
          const stored = approved && inventory.find(doc => doc.id === approved.document.id && doc.typeId === slot.typeId && doc.state === "ready");
          if (!approved || !stored || !item.storedDocument) throw new ProtocolChangedError("Reviewed stored attachment disappeared");
          const fresh = await this.documents.snapshot(current.context, stored);
          if (fingerprint(fresh.document) !== fingerprint(item.storedDocument) || fingerprint(approved.document) !== fingerprint(item.storedDocument)) throw new ProtocolChangedError("Stored PDF changed after review");
          fields.set(item.requirementId, fresh.document.id);
        } else {
          if (item.storedDocument) throw new ProtocolChangedError("Missing stored document review");
          const uploaded = await this.uploadAttachment(current, slot.typeId, file);
          fields.set(item.requirementId, uploaded.id);
        }
      }
    }
    for (const answer of manifest.answers) {
      const question = current.form.questions.find(item => item.id === answer.questionId);
      if (!question) throw new ProtocolChangedError("Question disappeared");
      if (typeof answer.value === "boolean") {
        if (answer.value) fields.set(question.id, question.options?.[0]?.id ?? "on");
      } else if (Array.isArray(answer.value)) {
        // The site's serializeFormToObject + jQuery encoder represents groups as arrays.
        for (const value of answer.value) fields.append(question.id.endsWith("[]") ? question.id : `${question.id}[]`, value);
      } else fields.set(question.id, String(answer.value));
    }
    // File uploads can take time. Check authoritative eligibility again before the commit.
    const posting = jsonObject(await this.http.read(current.context.session, APPLICATION_PATH, new URLSearchParams({ action: current.dataAction, postingId: manifest.jobId })));
    const status = posting.applicationData as Record<string, unknown> | undefined;
    if (!status || status.canApply !== true || status.hasApplication !== false || Date.parse(manifest.deadline) <= Date.now()) throw new ProtocolChangedError("Posting became unavailable during staging");
    beforeFinalSubmit();
    const receipt = jsonObject(await this.http.request(current.context.session, APPLICATION_PATH, fields));
    if (receipt.valid !== true || !/^[1-9]\d*$/.test(String(receipt.naId ?? ""))) throw new ProtocolChangedError("Application receipt is missing; inspect the application before retrying");
    const after = jsonObject(await this.http.read(current.context.session, APPLICATION_PATH, new URLSearchParams({ action: current.dataAction, postingId: manifest.jobId })));
    if ((after.applicationData as Record<string, unknown> | undefined)?.hasApplication !== true) throw new ProtocolChangedError("Application receipt could not be reconciled");
    // Confirmation is a receipt read. The Application Options Submit request above is the commit.
    const confirmation = await this.http.read(current.context.session, APPLICATION_PATH, new URLSearchParams({ action: current.page.confirmationAction, postingId: manifest.jobId }));
    if (!/application|submitted|confirmation/i.test(text(confirmation)) || /<input[^>]+type=["']password/i.test(confirmation)) throw new ProtocolChangedError("Application confirmation is unavailable");
    return { applicationId: String(receipt.naId), jobId: manifest.jobId, status: "submitted", manifestHash: fingerprint(manifest), externalSteps: [...manifest.externalSteps] };
  }

  private async current(jobId: string, expectedAccount?: string): Promise<CurrentApplication> {
    checkJobId(jobId);
    const context = await this.documents.context(expectedAccount);
    const html = await this.http.read(context.session, APPLICATION_PATH);
    const bootstrap = parseBootstrapPage(html);
    const dataAction = requirePostingAction(bootstrap, "data");
    const raw = jsonObject(await this.http.read(context.session, APPLICATION_PATH, new URLSearchParams({ action: dataAction, postingId: jobId })));
    const overviewBody = await this.http.read(context.session, APPLICATION_PATH, new URLSearchParams({ action: requirePostingAction(bootstrap, "overview"), postingId: jobId }));
    let overview = overviewBody;
    try { const parsed: unknown = JSON.parse(overviewBody); if (typeof parsed === "string") overview = parsed; } catch { /* Plain HTML is also supported by the observed read endpoint. */ }
    const posting = normalizeJobPosting(jobId, raw, overview, undefined);
    if (posting.canApply !== true || posting.hasApplication !== false || posting.application?.method !== "WaterlooWorks") throw new ProtocolChangedError("Posting is unavailable, already applied, or has an unsupported application route");
    const entry = jsonObject(await this.http.read(context.session, APPLICATION_PATH, new URLSearchParams({ action: discoverPageAction(html, "createApplication"), postingId: jobId })));
    if (entry.canApply !== true || entry.hasApplication !== false || entry.expressedIntention || !entry.form) throw new ProtocolChangedError("Unsupported application route; no intention-to-apply action was sent");
    const route = fieldsRecord(entry.form);
    if (Object.keys(route).some(key => key !== "action" && key !== "postingId") || route.postingId !== jobId || !route.action) throw new ProtocolChangedError("Application entry form changed");
    const page = parseApplicationPage(await this.http.read(context.session, APPLICATION_PATH, new URLSearchParams(route)));
    if (page.privateFields.postingId !== jobId || page.privateFields.uiForm !== "true" || page.privateFields.wizardMode !== "true" || !page.packageName) throw new ProtocolChangedError("Application wizard identity changed");
    const blockers = [...page.blockers];
    if (page.uploadSaveFields.postingId !== jobId || page.uploadSaveFields.uiForm !== "true") blockers.push("Attachment upload identity changed");
    for (const requirement of page.requirements) {
      if (requirement.role !== "system" || !requirement.selectedDocument) continue;
      try { requirement.selectedDocument = pinSystemDocument(await this.documents.read(context, { ...requirement.selectedDocument, state: "ready" })); }
      catch { blockers.push(`System document cannot be read: ${requirement.label}`); }
    }
    const externalSteps = posting.application?.additionalInformation ? [posting.application.additionalInformation] : [];
    const form: ApplicationForm = {
      accountKey: context.accountKey, accountLabel: context.accountLabel, jobId,
      title: posting.title ?? "", employer: posting.organization ?? "", term: posting.workTerm ?? "",
      deadline: applicationDeadline(posting.deadline), canApply: posting.canApply, hasApplication: posting.hasApplication,
      requirements: page.requirements, questions: page.questions, blockers, externalSteps, version: "",
    };
    if (posting.hasPreScreening && !page.questions.length) form.blockers.push("Posting has pre-screening questions that could not be understood");
    form.version = fingerprint([form.requirements, form.questions, form.deadline, form.externalSteps]);
    return { context, page, form, dataAction };
  }

  private async uploadAttachment(current: CurrentApplication, typeId: string, file: PreparedFile, verifyExact = true): Promise<LibraryDocument> {
    if (file.size >= current.page.uploadMaxBytes) throw new ProtocolChangedError("Attachment exceeds the observed site limit");
    const staged = new FormData();
    staged.set("action", current.page.uploadAction); staged.set("uploadDirectory", current.page.uploadDirectory);
    staged.set("upload", new Blob([new Uint8Array(file.bytes)], { type: "application/pdf" }), file.filename);
    const response = jsonObject(await this.http.request(current.context.session, APPLICATION_PATH, staged));
    if (typeof response.uuid !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(response.uuid)) throw new ProtocolChangedError("Attachment staging could not be verified");
    const save = new FormData();
    for (const [key, value] of Object.entries(current.page.uploadSaveFields)) save.set(key, value);
    save.set("docType", typeId); save.set("docName", file.filename); save.set("docUploaded", response.uuid); save.set("removeFile_docUpload", "false");
    save.delete("defaultDoc");
    const saved = jsonObject(await this.http.request(current.context.session, APPLICATION_PATH, save));
    if (!/^[1-9]\d*$/.test(String(saved.docId ?? ""))) throw new ProtocolChangedError("Attachment document could not be verified");
    const document = await this.documents.read(current.context, { id: String(saved.docId), typeId, name: file.filename, revision: "pending", state: "ready", source: "library" });
    if (verifyExact && document.revision !== file.sha256) throw new ProtocolChangedError("Stored attachment differs from approved bytes");
    return document;
  }
}

function checkJobId(id: string) { if (!/^\d+$/.test(id)) throw new ProtocolChangedError("Posting identifier must be numeric"); }
