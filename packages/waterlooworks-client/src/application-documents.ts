import { assertReadableStoredPdf } from "./stored-pdf.js";
import { createHash } from "node:crypto";
import type { WaterlooWorksSession } from "../../shared/src/protocol.js";
import type { LibraryDocument, PreparedFile } from "../../application-workflow/src/types.js";
import { fingerprint } from "../../application-workflow/src/fingerprint.js";
import { ApplicationHttp, DOCUMENT_PATH } from "./application-http.js";
import { buildFormFields, fieldsRecord, hiddenFields, jsonObject, navigationFields, pageDocument, sourceAction, text } from "./application-fields.js";
import { discoverPageAction, parsePageLiteral } from "./bootstrap.js";
import { ProtocolChangedError } from "./errors.js";

export interface DocumentContext { session: WaterlooWorksSession; html: string; accountKey: string; accountLabel: string }

export class ApplicationDocuments {
  constructor(private readonly http: ApplicationHttp) {}

  async context(expectedAccount?: string): Promise<DocumentContext> {
    const session = await this.http.session();
    const html = await this.http.read(session, DOCUMENT_PATH);
    const owner = navigationFields(html, "Upload A Document").ownerId;
    if (!owner || !/^\d+$/.test(owner)) throw new ProtocolChangedError("Verified document owner is unavailable");
    const accountKey = fingerprint(["waterlooworks", owner]);
    if (expectedAccount && accountKey !== expectedAccount) throw new ProtocolChangedError("WaterlooWorks account changed");
    return { session, html, accountKey, accountLabel: `WaterlooWorks student account (${owner.slice(-4)})` };
  }

  async inventory(context: DocumentContext): Promise<LibraryDocument[]> {
    const links = [...pageDocument(context.html).querySelectorAll("a[onclick]")];
    const types = new Map<string, Record<string, string>>();
    for (const link of links) {
      if (!/docOwnerStats/.test(link.getAttribute("onclick")!)) continue;
      const fields = buildFormFields(link.getAttribute("onclick")!);
      if (fields.docTypeId && /^\d+$/.test(fields.docTypeId)) types.set(fields.docTypeId, fields);
    }
    if (!types.size || types.size > 12) throw new ProtocolChangedError("Unsupported document inventory");
    const documents: LibraryDocument[] = [];
    for (const [typeId, fields] of types) {
      const page = await this.http.read(context.session, DOCUMENT_PATH, new URLSearchParams({ ...fields, numOfDays: "0" }));
      const additional = /var\s+doc_commonTable_additionalParams\s*=\s*(\{[^;]*\})/.exec(page)?.[1];
      const method = page.slice(page.indexOf("function doc_commonTable(page"));
      if (!additional || !method) throw new ProtocolChangedError("Unsupported document table");
      const extra = fieldsRecord(parsePageLiteral(additional));
      const instance = /gridInstanceId:\s*["']([^"']+)["']/.exec(method)?.[1];
      const module = /modId:\s*["']([^"']+)["']/.exec(method)?.[1];
      if (!instance || !module) throw new ProtocolChangedError("Document table identifiers are missing");
      const known = new Set<string>();
      for (let index = 1; index <= 20; index++) {
        const body = await this.http.read(context.session, DOCUMENT_PATH, new URLSearchParams({ ...extra,
          action: discoverPageAction(page, "doc_commonTable"), gridID: "doc_commonTable", gridInstanceId: instance,
          initialLoad: "true", modId: module, itemsPerPage: "100", page: String(index), orderBy: "[]", gridFilters: "[]", gridAdditionalParams: JSON.stringify(parsePageLiteral(additional)),
        }));
        const rows = [...pageDocument(body).querySelectorAll("tr")].filter(row => row.querySelector("input.ms_check"));
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

  async read(context: DocumentContext, document: LibraryDocument): Promise<LibraryDocument> {
    if (document.state !== "ready") return { ...document };
    return (await this.snapshot(context, document)).document;
  }

  async snapshot(context: DocumentContext, document: LibraryDocument): Promise<{ document: LibraryDocument; bytes: Uint8Array }> {
    if (document.state !== "ready") throw new ProtocolChangedError("Document is not ready");
    const action = sourceAction(context.html, "orbisApp.docPreview.getDocument =");
    const data = jsonObject(await this.http.read(context.session, DOCUMENT_PATH, new URLSearchParams({ action, docId: document.id }), true));
    if (typeof data.doc !== "string" || data.doc.length > 7_000_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(data.doc)) throw new ProtocolChangedError("Document PDF could not be read");
    const bytes = Buffer.from(data.doc, "base64");
    await assertReadableStoredPdf(new Uint8Array(bytes));
    return { document: { ...document, revision: createHash("sha256").update(bytes).digest("hex") }, bytes: new Uint8Array(bytes) };
  }

  async upload(context: DocumentContext, typeId: string, name: string, file: PreparedFile, allowProcessed = false): Promise<LibraryDocument> {
    const page = await this.http.read(context.session, DOCUMENT_PATH, new URLSearchParams(navigationFields(context.html, "Upload A Document")));
    const doc = pageDocument(page);
    const form = doc.querySelector("#fileUploadForm");
    const type = form?.querySelector(`select[name=docType] option[value="${typeId}"]`);
    const init = /orbisFileUpload\.init\(\s*'docUpload'\s*,\s*'([^']*)'\s*,\s*'[^']*'\s*,\s*'([^']*)'\s*,\s*(\d+)/.exec(page);
    const action = doc.querySelector("#fileUploadAction_docUpload")?.getAttribute("value");
    if (!form || !type || !action || !init || !init[2]!.split(",").includes("pdf") || file.size >= Number(init[3])) throw new ProtocolChangedError("Unsupported upload form or file limit");
    const fields = hiddenFields(form);
    if (!fields.action || form.getAttribute("method")?.toLowerCase() !== "post" || !form.querySelector("input[name=docUploaded]")) throw new ProtocolChangedError("Unsupported document save form");
    const upload = new FormData();
    upload.set("action", action); upload.set("uploadDirectory", init[1]!);
    upload.set("upload", new Blob([new Uint8Array(file.bytes)], { type: "application/pdf" }), file.filename);
    const staged = jsonObject(await this.http.request(context.session, DOCUMENT_PATH, upload));
    if (typeof staged.uuid !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(staged.uuid)) throw new ProtocolChangedError("File staging could not be verified");
    const save = new FormData();
    for (const [key, value] of Object.entries(fields)) if (key !== "defaultDoc") save.set(key, value);
    save.set("docType", typeId); save.set("docName", name); save.set("docUploaded", staged.uuid); save.set("removeFile_docUpload", "false");
    await this.http.request(context.session, DOCUMENT_PATH, save);
    const fresh = await this.context(context.accountKey);
    const matches = (await this.inventory(fresh)).filter(item => item.typeId === typeId && item.name === name && item.state === "ready");
    if (matches.length !== 1) throw new ProtocolChangedError("Uploaded document identity is ambiguous; inspect the library before retrying");
    const result = await this.read(fresh, matches[0]!);
    if (!allowProcessed && result.revision !== file.sha256) throw new ProtocolChangedError("Uploaded PDF differs from approved bytes");
    return result;
  }

  async defaults(context: DocumentContext, typeId: string, documentIds: string[]): Promise<{ documentIds: string[] }> {
    const fields = navigationFields(context.html, "Update Default");
    fields.selectedDocType = typeId;
    const page = await this.http.read(context.session, DOCUMENT_PATH, new URLSearchParams(fields));
    const form = pageDocument(page).querySelector("#defaultDocsForm");
    const max = /input\[name=defaultDocs\]:checked'\)\.length\s*<=\s*(\d+)/.exec(page)?.[1];
    if (!form || !max || documentIds.length > Number(max)) throw new ProtocolChangedError("Default selection exceeds the observed site limit");
    const allowed = new Set([...form.querySelectorAll("input[name=defaultDocs]")].map(input => input.getAttribute("value")));
    if (documentIds.some(id => !allowed.has(id))) throw new ProtocolChangedError("Default document is no longer available");
    const save = new FormData();
    for (const [key, value] of Object.entries(hiddenFields(form))) save.set(key, value);
    if (save.get("docType") !== typeId || !save.get("action")) throw new ProtocolChangedError("Default document type changed");
    for (const id of documentIds) save.append("defaultDocs", id);
    await this.http.request(context.session, DOCUMENT_PATH, save);
    const fresh = await this.context(context.accountKey);
    const verifyFields = { ...navigationFields(fresh.html, "Update Default"), selectedDocType: typeId };
    const verify = pageDocument(await this.http.read(fresh.session, DOCUMENT_PATH, new URLSearchParams(verifyFields)));
    const selected = [...verify.querySelectorAll('#defaultDocsForm input[name=defaultDocs]')].filter(input => [...input.attributes].some(attribute => attribute.name.toLowerCase() === "checked")).map(input => input.getAttribute("value")!);
    if (fingerprint([...selected].sort()) !== fingerprint([...documentIds].sort())) throw new ProtocolChangedError("Default documents were not saved as approved");
    return { documentIds: [...documentIds] };
  }
}
