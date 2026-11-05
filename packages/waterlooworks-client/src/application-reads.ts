import { readAccountEmail } from "./account-email.js";
import { applicationsNavigation } from "./applications-navigation.js";
import { PDFDocument } from "pdf-lib";
import { applicationReadEvidence } from "./application-read-evidence.js";
import { sha256 } from "../../shared/src/sha256.js";
import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";
import { fingerprint } from "../../application-workflow/src/fingerprint.js";
import type { ApplicationForm, ApplicationInventory, LibraryDocument } from "../../application-workflow/src/types.js";
import { applicationListRequest, parseApplications } from "./applications.js";
import { applicationDeadline } from "./application-deadline.js";
import { buildFormFields, fieldsRecord, jsonObject, navigationFields, pageDocument, sourceAction, text } from "./application-fields.js";
import { discoverPageAction, parseBootstrapPage, parsePageLiteral, requirePostingAction } from "./bootstrap.js";
import { parseApplicationPage } from "./application-page.js";
import { normalizeJobPosting } from "./normalize.js";
import { AuthenticationExpiredError, ProtocolChangedError, WaterlooWorksServerError } from "./errors.js";
import type { FetchLike } from "./session.js";

interface ReadContext { html: string; accountKey: string; accountLabel: string }
interface ApplicationState { form: ApplicationForm; dataAction: string; entryFields: Record<string,string> }
const MAX_RESPONSE_BYTES = 12_000_000;
const APPLICATION_PATH = "/myAccount/co-op/full/jobs.htm" as const;
const DOCUMENT_PATH = "/myAccount/co-op/full/documents.htm" as const;
const APPLICATIONS_PATH = "/myAccount/co-op/full/applications.htm" as const;

/** Browser-only, read-only application and document library operations. */
export class BrowserApplicationReads {
  applicationInventoryEvidence: ReturnType<typeof applicationReadEvidence> | undefined;
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async getAccount(): Promise<{ accountKey: string; accountLabel: string }> {
    const context = await this.context();
    return { accountKey: context.accountKey, accountLabel: context.accountLabel };
  }

  /** Only an authenticated profile field is evidence; posting/contact text is not. */
  async getVerifiedEmail(): Promise<string> {
    return readAccountEmail(this.fetchImpl);
  }

  async listDocuments(): Promise<LibraryDocument[]> {
    const context = await this.context();
    return this.inventory(context);
  }

  async getDocument(documentId: string): Promise<LibraryDocument> {
    const context = await this.context();
    const document = (await this.inventory(context)).find((item) => item.id === documentId);
    if (!document) throw new ProtocolChangedError("Selected document is no longer in the library");
    return (await this.snapshot(context, document)).document;
  }

  async getDocumentSnapshot(documentId: string): Promise<{ document: LibraryDocument; bytes: Uint8Array }> {
    if (!/^\d+$/.test(documentId)) throw new ProtocolChangedError("Invalid document identifier");
    const context = await this.context();
    const document = (await this.inventory(context)).find((item) => item.id === documentId);
    if (!document) throw new ProtocolChangedError("Selected document disappeared");
    return this.snapshot(context, document);
  }

  async getApplicationForm(jobId: string): Promise<ApplicationForm> {
    return (await this.current(jobId)).form;
  }

  /** Browser-internal read navigation; private action fields never cross the broker. */
  async getApplicationEntry(jobId: string) {
    const state = await this.current(jobId);
    return { fields: state.entryFields, formVersion: state.form.version };
  }

  async listApplications(): Promise<ApplicationInventory> {
    const account = await this.context();
    const {path,request} = await this.applicationListContext();
    const applications: ApplicationInventory["applications"] = [];
    const seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const result = parseApplications(jsonObject(await this.read(path, new URLSearchParams({ ...request,
        page: String(page), itemsPerPage: "200", sort: JSON.stringify([{ key: "applicationSubmittedOn", direction: "desc" }]), filters: "null", isDataViewer: "true" }))));
      if (total !== undefined && total !== result.total) throw new ProtocolChangedError("Applications changed while listing; refresh again");
      total = result.total;
      for (const item of result.applications) {
        if (seen.has(item.applicationId)) throw new ProtocolChangedError("Applications pagination repeated a row");
        seen.add(item.applicationId); applications.push(item);
      }
      if (applications.length === total) {
        await this.context(account.accountKey);
        return { accountKey: account.accountKey, checkedAt: new Date().toISOString(), termId: request.selectedTerm!, applications };
      }
      if (!result.applications.length || applications.length > total) throw new ProtocolChangedError("Applications list is incomplete");
    }
    throw new ProtocolChangedError("Applications list exceeds pagination limit");
  }

  private async applicationListContext() {
    const inspect = (html: string) => {
      this.applicationInventoryEvidence = applicationReadEvidence(html);
      return applicationListRequest(html);
    };
    const legacy = await this.read(APPLICATIONS_PATH);
    try { return {path:APPLICATIONS_PATH,request:inspect(legacy)}; }
    catch (error) { if (!(error instanceof ProtocolChangedError)) throw error; }
    // Full-cycle accounts can expose applications through Jobs / Applications
    // navigation rather than a standalone applications.htm page. Use only the
    // literal read request or the site's My Applications navigation fields.
    const jobs = await this.read(APPLICATION_PATH);
    try { return {path:APPLICATION_PATH,request:inspect(jobs)}; }
    catch (error) { if (!(error instanceof ProtocolChangedError)) throw error; }
    let path: typeof APPLICATION_PATH | typeof APPLICATIONS_PATH = APPLICATION_PATH;
    let navigation: Record<string,string>;
    if (jobs.includes("goToApplicationsGrid")) {
      navigation = applicationsNavigation(jobs);
      path = APPLICATIONS_PATH;
    } else navigation = navigationFields(jobs,"My Applications");
    let page = await this.read(path,new URLSearchParams(navigation));
    try { const parsed: unknown = JSON.parse(page); if(typeof parsed === "string") page=parsed; } catch { /* HTML response. */ }
    return {path,request:inspect(page)};
  }

  async getApplicationStatus(jobId: string): Promise<{ jobId: string; hasApplication: boolean }> {
    checkJobId(jobId);
    const html = await this.read(APPLICATION_PATH);
    const bootstrap = parseBootstrapPage(html);
    const data = jsonObject(await this.read(APPLICATION_PATH, new URLSearchParams({
      action: requirePostingAction(bootstrap, "data"), postingId: jobId,
    })));
    const application = data.applicationData;
    if (!application || typeof application !== "object" || typeof (application as Record<string, unknown>).hasApplication !== "boolean") {
      // Expired postings omit hasApplication. Absence is meaningful only within
      // the complete inventory's verified recruiting term, never across terms.
      const inventory = await this.listApplications();
      const match = inventory.applications.find(item => item.jobId === jobId && item.status === "Applied");
      if (match) return { jobId, hasApplication: true };
      const selectedTerm = bootstrap.filters.find(filter => filter.key === "Term")?.options?.find(option => option.value === inventory.termId)?.label;
      if (selectedTerm) {
        let overview = await this.read(APPLICATION_PATH, new URLSearchParams({ action: requirePostingAction(bootstrap, "overview"), postingId: jobId }));
        try { const parsed: unknown = JSON.parse(overview); if (typeof parsed === "string") overview = parsed; } catch { /* HTML response. */ }
        if (normalizeJobPosting(jobId, data, overview, undefined).workTerm === selectedTerm) return { jobId, hasApplication: false };
      }
      throw new ProtocolChangedError("Application status is unavailable");
    }
    return { jobId, hasApplication: (application as { hasApplication: boolean }).hasApplication };
  }

  private async context(expectedAccount?: string): Promise<ReadContext> {
    const html = await this.read(DOCUMENT_PATH);
    const owner = navigationFields(html, "Upload A Document").ownerId;
    if (!owner || !/^\d+$/.test(owner)) throw new ProtocolChangedError("Verified document owner is unavailable");
    const accountKey = fingerprint(["waterlooworks", owner]);
    if (expectedAccount && accountKey !== expectedAccount) throw new ProtocolChangedError("WaterlooWorks account changed");
    return { html, accountKey, accountLabel: `WaterlooWorks student account (${owner.slice(-4)})` };
  }

  private async inventory(context: ReadContext): Promise<LibraryDocument[]> {
    const links = [...pageDocument(context.html).querySelectorAll("a[onclick]")];
    const types = new Map<string, Record<string, string>>();
    for (const link of links) {
      if (!/docOwnerStats/.test(link.getAttribute("onclick") ?? "")) continue;
      const fields = buildFormFields(link.getAttribute("onclick") ?? "");
      if (fields.docTypeId && /^\d+$/.test(fields.docTypeId)) types.set(fields.docTypeId, fields);
    }
    if (!types.size || types.size > 12) throw new ProtocolChangedError("Unsupported document inventory");
    const documents: LibraryDocument[] = [];
    for (const [typeId, fields] of types) {
      const page = await this.read(DOCUMENT_PATH, new URLSearchParams({ ...fields, numOfDays: "0" }));
      const additional = /var\s+doc_commonTable_additionalParams\s*=\s*(\{[^;]*\})/.exec(page)?.[1];
      const method = page.slice(page.indexOf("function doc_commonTable(page"));
      if (!additional || !method) throw new ProtocolChangedError("Unsupported document table");
      const extra = fieldsRecord(parsePageLiteral(additional));
      const instance = /gridInstanceId:\s*["']([^"']+)["']/.exec(method)?.[1];
      const module = /modId:\s*["']([^"']+)["']/.exec(method)?.[1];
      if (!instance || !module) throw new ProtocolChangedError("Document table identifiers are missing");
      const known = new Set<string>();
      for (let index = 1; index <= 20; index++) {
        const body = await this.read(DOCUMENT_PATH, new URLSearchParams({ ...extra, action: discoverPageAction(page, "doc_commonTable"),
          gridID: "doc_commonTable", gridInstanceId: instance, initialLoad: "true", modId: module, itemsPerPage: "100", page: String(index),
          orderBy: "[]", gridFilters: "[]", gridAdditionalParams: JSON.stringify(parsePageLiteral(additional)) }));
        const rows = [...pageDocument(body).querySelectorAll("tr")].filter((row) => row.querySelector("input.ms_check"));
        for (const row of rows) {
          const id = row.querySelector("input.ms_check")?.id.replace(/^doc_commonTable_record/, "");
          const cells = [...row.querySelectorAll("td")];
          if (!id || !/^\d+$/.test(id) || cells.length !== 7 || known.has(id)) throw new ProtocolChangedError("Document table rows changed or repeated");
          known.add(id);
          const nameCell = cells[2]!.cloneNode(true) as Element;
          for (const badge of nameCell.querySelectorAll(".badge")) badge.remove();
          const name = text(nameCell.textContent);
          const archived = text(cells[6]!.textContent) === "Yes";
          const broken = /Broken Document|Pending|Processing/i.test(text(cells[1]!.textContent)) || !row.querySelector("[data-doc-id]");
          documents.push({ id, typeId, name, revision: fingerprint([id, name, text(cells[4]!.textContent)]),
            state: archived ? "archived" : broken ? "unknown" : "ready",
            source: /Grade Report|Co-op Work History/i.test(text(cells[3]!.textContent)) ? "system" : "library" });
        }
        if (rows.length < 100) break;
        if (index === 20) throw new ProtocolChangedError("Document inventory exceeds supported pagination limit");
      }
    }
    return documents;
  }

  private async snapshot(context: ReadContext, document: LibraryDocument): Promise<{ document: LibraryDocument; bytes: Uint8Array }> {
    if (document.state !== "ready") throw new ProtocolChangedError("Document is not ready");
    const action = sourceAction(context.html, "orbisApp.docPreview.getDocument =");
    const data = jsonObject(await this.read(DOCUMENT_PATH, new URLSearchParams({ action, docId: document.id }), true));
    if (typeof data.doc !== "string" || data.doc.length > 7_000_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(data.doc)) throw new ProtocolChangedError("Document PDF could not be read");
    let binary: string;
    try { binary = atob(data.doc.replace(/[\r\n]/g, "")); } catch { throw new ProtocolChangedError("Document PDF could not be read"); }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, 8));
    const suffix = new TextDecoder("latin1").decode(bytes.subarray(-1024));
    if (!prefix.startsWith("%PDF-") || !suffix.includes("%%EOF")) throw new ProtocolChangedError("Stored document is not a readable PDF");
    try {
      const pdf = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
      if (pdf.isEncrypted || pdf.getPageCount() < 1) throw new Error("Unreadable PDF");
    } catch { throw new ProtocolChangedError("Stored document is not a readable PDF"); }
    return { document: { ...document, revision: sha256(bytes) }, bytes };
  }

  private async current(jobId: string): Promise<ApplicationState> {
    checkJobId(jobId);
    const context = await this.context();
    const html = await this.read(APPLICATION_PATH);
    const bootstrap = parseBootstrapPage(html);
    const dataAction = requirePostingAction(bootstrap, "data");
    const raw = jsonObject(await this.read(APPLICATION_PATH, new URLSearchParams({ action: dataAction, postingId: jobId })));
    const overviewBody = await this.read(APPLICATION_PATH, new URLSearchParams({ action: requirePostingAction(bootstrap, "overview"), postingId: jobId }));
    let overview = overviewBody;
    try { const parsed: unknown = JSON.parse(overviewBody); if (typeof parsed === "string") overview = parsed; } catch { /* The observed endpoint may return plain HTML. */ }
    const posting = normalizeJobPosting(jobId, raw, overview, undefined);
    if (posting.canApply !== true || posting.hasApplication !== false || posting.application?.method !== "WaterlooWorks") throw new ProtocolChangedError("Posting is unavailable, already applied, or has an unsupported application route");
    const entry = jsonObject(await this.read(APPLICATION_PATH, new URLSearchParams({ action: discoverPageAction(html, "createApplication"), postingId: jobId })));
    if (entry.canApply !== true || entry.hasApplication !== false || entry.expressedIntention || !entry.form) throw new ProtocolChangedError("Unsupported application route; no intention-to-apply action was sent");
    const route = fieldsRecord(entry.form);
    if (Object.keys(route).some((key) => key !== "action" && key !== "postingId") || route.postingId !== jobId || !route.action) throw new ProtocolChangedError("Application entry form changed");
    const page = parseApplicationPage(await this.read(APPLICATION_PATH, new URLSearchParams(route)));
    if (page.privateFields.postingId !== jobId || page.privateFields.uiForm !== "true" || page.privateFields.wizardMode !== "true" || !page.packageName) throw new ProtocolChangedError("Application wizard identity changed");
    const blockers = [...page.blockers];
    if (page.uploadSaveFields.postingId !== jobId || page.uploadSaveFields.uiForm !== "true") blockers.push("Attachment upload identity changed");
    for (const requirement of page.requirements) {
      if (requirement.role !== "system" || !requirement.selectedDocument) continue;
      try { requirement.selectedDocument = (await this.snapshot(context, { ...requirement.selectedDocument, state: "ready" })).document; }
      catch { blockers.push(`System document cannot be read: ${requirement.label}`); }
    }
    const form: ApplicationForm = {
      accountKey: context.accountKey, accountLabel: context.accountLabel, jobId,
      title: posting.title ?? "", employer: posting.organization ?? "", term: posting.workTerm ?? "",
      deadline: applicationDeadline(posting.deadline), canApply: posting.canApply, hasApplication: posting.hasApplication,
      requirements: page.requirements, questions: page.questions, blockers,
      externalSteps: posting.application?.additionalInformation ? [posting.application.additionalInformation] : [], version: "",
    };
    if (posting.hasPreScreening && !page.questions.length) form.blockers.push("Posting has pre-screening questions that could not be understood");
    form.version = fingerprint([form.requirements, form.questions, form.deadline, form.externalSteps]);
    return { form, dataAction, entryFields: route };
  }

  private async read(path: typeof APPLICATION_PATH | typeof DOCUMENT_PATH | typeof APPLICATIONS_PATH, body?: URLSearchParams, query = false): Promise<string> {
    if (path !== APPLICATION_PATH && path !== DOCUMENT_PATH && path !== APPLICATIONS_PATH) throw new ProtocolChangedError("Unsupported application destination");
    const url = new URL(path, WATERLOOWORKS_ORIGIN);
    if (query && body) for (const [key, value] of body) url.searchParams.append(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: body === undefined || query ? "GET" : "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "x-requested-with": "XMLHttpRequest", ...(body && !query ? { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } : {}) },
        ...(body && !query ? { body } : {}), signal: AbortSignal.timeout(30_000) });
    } catch (error) { throw new WaterlooWorksServerError("WaterlooWorks application read failed", error); }
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new AuthenticationExpiredError();
    if (!response.ok) throw new WaterlooWorksServerError(`Application operation returned HTTP ${response.status}`);
    if (response.url) {
      try { if (new URL(response.url).origin !== WATERLOOWORKS_ORIGIN) throw new AuthenticationExpiredError(); }
      catch (error) { if (error instanceof AuthenticationExpiredError) throw error; throw new AuthenticationExpiredError(); }
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ProtocolChangedError("Application response exceeded size limit"); }
          chunks.push(part.value);
        }
      } catch (error) {
        if (error instanceof ProtocolChangedError) throw error;
        throw new WaterlooWorksServerError("Application response was interrupted", error);
      }
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    const prefix = new TextDecoder().decode(joined.subarray(0, 2048));
    const encoding = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1]
      ?? /charset\s*=\s*["']?([\w-]+)/i.exec(prefix)?.[1] ?? "utf-8";
    let result: string;
    try { result = new TextDecoder(encoding).decode(joined); }
    catch { throw new ProtocolChangedError("Unsupported application response encoding"); }
    if (/<input[^>]+type=["']password/i.test(result) || /<title>[^<]*(?:Sign In|Not Logged In)/i.test(result)) throw new AuthenticationExpiredError();
    return result;
  }
}

function checkJobId(id: string): void { if (!/^\d+$/.test(id)) throw new ProtocolChangedError("Posting identifier must be numeric"); }
