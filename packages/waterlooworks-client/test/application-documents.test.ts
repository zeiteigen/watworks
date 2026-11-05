import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { readApplicationPdf } from "../../application-workflow/src/files.js";
import { ApplicationDocuments } from "../src/application-documents.js";
import { ApplicationHttp, DOCUMENT_PATH } from "../src/application-http.js";
import { createStaticSession } from "../src/session.js";
import type { LibraryDocument, PreparedFile } from "../../application-workflow/src/types.js";

const session = createStaticSession([{ name: "WW_SESSION", value: "synthetic-test-cookie", domain: "waterlooworks.uwaterloo.ca", path: "/", secure: true, httpOnly: true }]);
const syntheticPdf = await PDFDocument.create();
syntheticPdf.addPage();
const pdfBytes = Buffer.from(await syntheticPdf.save());
const file: PreparedFile = { filename: "letter.pdf", size: pdfBytes.length, sha256: createHash("sha256").update(pdfBytes).digest("hex"), bytes: new Uint8Array(pdfBytes) };
const overview = `
  <a onclick="buildForm({action:'upload-navigation-test',ownerId:'12345'})">Upload A Document</a>
  <a onclick="buildForm({action:'defaults-navigation-test',ownerId:'12345'})">Update Default</a>
  <a onclick="buildForm({action:'docOwnerStats-test',ownerId:'12345',docTypeId:'1'})">Resumes</a>
  <script>orbisApp.docPreview.getDocument = function() { return {action:'preview-source-test'}; };</script>`;
const table = `<script>
  var doc_commonTable_additionalParams = {docTypeId:'1',ownerId:'12345'};
  function doc_commonTable(page) { return {action:'table-source-test',gridInstanceId:'grid-test',modId:'module-test'}; }
</script>`;
const uploadPage = `<form id="fileUploadForm" method="POST">
  <input type="hidden" name="action" value="save-source-test">
  <input type="hidden" name="ownerId" value="12345">
  <input type="hidden" name="sourceNonce" value="synthetic-source-nonce">
  <input type="hidden" name="defaultDoc" value="true">
  <input type="hidden" name="docUploaded" value="">
  <select name="docType"><option value="1">Resume</option><option value="2">Cover letter</option></select>
</form><input id="fileUploadAction_docUpload" value="stage-source-test">
<script>orbisFileUpload.init('docUpload','synthetic-upload-directory','unused','pdf',5000000);</script>`;
function row(id: string, options: { name?: string; status?: string; archived?: boolean; source?: string; preview?: boolean } = {}) {
  return `<tr><td><input class="ms_check" id="doc_commonTable_record${id}"></td><td>${options.status ?? "Ready"}</td>
    <td>${options.name ?? "Uploaded letter"}<span class="badge">Default</span>${options.preview === false ? "" : `<a data-doc-id="${id}"></a>`}</td>
    <td>${options.source ?? "Resume"}</td><td>Jan 1, 2027</td><td>unused</td><td>${options.archived ? "Yes" : "No"}</td></tr>`;
}
function defaultsPage(selected: string[] = ["101"], limit = 2) {
  return `<form id="defaultDocsForm"><input type="hidden" name="action" value="defaults-save-source-test">
    <input type="hidden" name="docType" value="1"><input type="hidden" name="sourceNonce" value="synthetic-default-nonce">
    ${["101", "102", "103"].map(id => `<input name="defaultDocs" value="${id}" type="checkbox" ${selected.includes(id) ? "CHECKED" : ""}>`).join("")}
  </form><script>if ($('input[name=defaultDocs]:checked').length <= ${limit}) { return true; }</script>`;
}
interface Call { url: URL; method: string; body: URLSearchParams | FormData | undefined; action: string | null }
interface HarnessOptions { pages?: (page: number) => string; storedBytes?: Uint8Array; defaultReadback?: string[]; overview?: string; stageResult?: unknown }
function harness(options: HarnessOptions = {}) {
  const calls: Call[] = [];
  let selected: string[] | undefined;
  const http = new ApplicationHttp({ getSession: async () => session }, async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body instanceof FormData || init?.body instanceof URLSearchParams ? init.body : undefined;
    const action = url.searchParams.get("action") ?? body?.get("action")?.toString() ?? null;
    calls.push({ url, method: init?.method ?? "GET", body, action });
    expect(url.origin).toBe("https://waterlooworks.uwaterloo.ca");
    expect(url.pathname).toBe(DOCUMENT_PATH);
    if (!action) return new Response(options.overview ?? overview);
    if (action === "docOwnerStats-test") return new Response(table);
    if (action === "table-source-test") return new Response(`<table>${options.pages?.(Number(body?.get("page"))) ?? row("101", { name: "Uploaded letter", preview: true })}</table>`);
    if (action === "upload-navigation-test") return new Response(uploadPage);
    if (action === "stage-source-test") return Response.json(options.stageResult ?? { uuid: "synthetic-staged-file.pdf" });
    if (action === "save-source-test") return new Response("Saved");
    if (action === "preview-source-test") return Response.json({ doc: Buffer.from(options.storedBytes ?? pdfBytes).toString("base64") });
    if (action === "defaults-navigation-test") return new Response(defaultsPage(selected === undefined ? ["101"] : options.defaultReadback ?? selected));
    if (action === "defaults-save-source-test") { selected = body!.getAll("defaultDocs").map(String); return new Response("Saved"); }
    throw new Error(`Unexpected synthetic action: ${action}`);
  });
  return { documents: new ApplicationDocuments(http), calls };
}
const ready: LibraryDocument = { id: "101", typeId: "1", name: "Uploaded letter", revision: "inventory-revision", state: "ready", source: "library" };

describe("source-derived document inventory and preview", () => {
  test("discovers account and table actions, removes badges, and distinguishes unavailable documents", async () => {
    const h = harness({ pages: () => [row("101", { name: "Resume" }), row("102", { name: "Broken", status: "Broken Document", preview: false }), row("103", { name: "Archived", archived: true }), row("104", { name: "Transcript", source: "Grade Report" })].join("") });
    const context = await h.documents.context();
    expect(context.accountKey).toMatch(/^[a-f0-9]{64}$/);
    expect(context.accountLabel).toContain("2345");
    const documents = await h.documents.inventory(context);
    expect(documents.map(doc => [doc.id, doc.state, doc.source])).toEqual([["101", "ready", "library"], ["102", "unknown", "library"], ["103", "archived", "library"], ["104", "ready", "system"]]);
    expect(documents[0]!.name).toBe("Resume");
    expect(documents[0]!.name).not.toContain("Default");
    const request = h.calls.find(call => call.action === "table-source-test")!;
    expect(request.body?.get("itemsPerPage")).toBe("100");
    expect(request.body?.get("gridInstanceId")).toBe("grid-test");
    expect(request.body?.get("modId")).toBe("module-test");
  });

  test("paginates full pages and rejects duplicate document IDs", async () => {
    const hundred = Array.from({ length: 100 }, (_, index) => row(String(index + 1000))).join("");
    const h = harness({ pages: page => page === 1 ? hundred : row("2000") });
    expect(await h.documents.inventory(await h.documents.context())).toHaveLength(101);
    expect(h.calls.filter(call => call.action === "table-source-test").map(call => call.body?.get("page"))).toEqual(["1", "2"]);
    const repeated = harness({ pages: () => hundred });
    await expect(repeated.documents.inventory(await repeated.documents.context())).rejects.toThrow("repeated");
    expect(repeated.calls.filter(call => call.action === "table-source-test")).toHaveLength(2);
  });

  test("bounds pagination to twenty pages", async () => {
    const h = harness({ pages: page => Array.from({ length: 100 }, (_, index) => row(String(page * 1000 + index))).join("") });
    await expect(h.documents.inventory(await h.documents.context())).rejects.toThrow("pagination limit");
    expect(h.calls.filter(call => call.action === "table-source-test")).toHaveLength(20);
  });

  test("reads content using GET query parameters and replaces metadata revision with exact PDF digest", async () => {
    const h = harness();
    const result = await h.documents.read(await h.documents.context(), ready);
    expect(result.revision).toBe(file.sha256);
    const call = h.calls.find(call => call.action === "preview-source-test")!;
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(call.url.searchParams.get("docId")).toBe("101");
    const count = h.calls.length;
    expect(await h.documents.read(await h.documents.context(), { ...ready, state: "archived" })).toMatchObject({ state: "archived", revision: ready.revision });
    expect(h.calls.length).toBe(count + 1);
  });

  test("rejects changed accounts and invalid stored PDF content", async () => {
    const h = harness();
    await expect(h.documents.context("b".repeat(64))).rejects.toThrow("account changed");
    for (const bytes of [Buffer.from("not a PDF"), Buffer.from("%PDF-1.7\nforged contents\n%%EOF\n")]) {
      const bad = harness({ storedBytes: bytes });
      await expect(bad.documents.read(await bad.documents.context(), ready)).rejects.toThrow("readable PDF");
    }
  });
});

describe("single-shot document upload", () => {
  test("uses two source-specific multipart stages, excludes defaults, and verifies read-back bytes", async () => {
    const correct = harness();
    const context = await correct.documents.context();
    const uploaded = await correct.documents.upload(context, "1", "Uploaded letter", file);
    expect(uploaded).toMatchObject({ id: "101", name: "Uploaded letter", revision: file.sha256, state: "ready" });
    const writes = correct.calls.filter(call => call.body instanceof FormData);
    expect(writes.map(call => call.action)).toEqual(["stage-source-test", "save-source-test"]);
    const stage = writes[0]!.body as FormData;
    expect(stage.get("uploadDirectory")).toBe("synthetic-upload-directory");
    const uploadedFile = stage.get("upload") as File;
    expect(uploadedFile.name).toBe("letter.pdf");
    expect(uploadedFile.type).toBe("application/pdf");
    expect(Buffer.from(await uploadedFile.arrayBuffer())).toEqual(Buffer.from(file.bytes));
    const save = writes[1]!.body as FormData;
    expect(save.get("docUploaded")).toBe("synthetic-staged-file.pdf");
    expect(save.get("docType")).toBe("1");
    expect(save.get("docName")).toBe("Uploaded letter");
    expect(save.get("ownerId")).toBe("12345");
    expect(save.get("sourceNonce")).toBe("synthetic-source-nonce");
    expect(save.get("removeFile_docUpload")).toBe("false");
    expect(writes.every(call => !call.body!.has("defaultDoc"))).toBe(true);
  });

  test("a locally valid exact 5 MB PDF is rejected by the site limit before staging bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "document-site-limit-test-"));
    try {
      const document = await PDFDocument.create();
      document.addPage();
      const original = Buffer.from(await document.save());
      const padded = Buffer.alloc(5_000_000, " ");
      original.copy(padded, 0, 0, original.lastIndexOf("%%EOF"));
      padded.write("\n%%EOF\n", padded.length - 7);
      const path = join(root, "boundary.pdf");
      await writeFile(path, padded);
      const prepared = await readApplicationPdf(path, [root]);
      expect(prepared.size).toBe(5_000_000);
      const h = harness();
      await expect(h.documents.upload(await h.documents.context(), "1", "Uploaded letter", prepared)).rejects.toThrow("file limit");
      expect(h.calls.some(call => call.body instanceof FormData)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each(["duplicate-name", "digest-mismatch"])("does not retry an upload after %s verification failure", async failure => {
    const changedPdf = await PDFDocument.create(); changedPdf.addPage().drawText("Different document");
    const changedBytes = await changedPdf.save();
    const h = harness({ pages: () => row("101") + (failure === "duplicate-name" ? row("102") : ""), ...(failure === "digest-mismatch" ? { storedBytes: changedBytes } : {}) });
    await expect(h.documents.upload(await h.documents.context(), "1", "Uploaded letter", file)).rejects.toThrow(failure === "duplicate-name" ? "ambiguous" : "differs from approved bytes");
    expect(h.calls.filter(call => call.action === "stage-source-test")).toHaveLength(1);
    expect(h.calls.filter(call => call.action === "save-source-test")).toHaveLength(1);
  });

  test("unverified staging token prevents document creation", async () => {
    const h = harness({ stageResult: { uuid: "../unsafe-token" } });
    await expect(h.documents.upload(await h.documents.context(), "1", "Uploaded letter", file)).rejects.toThrow("staging could not be verified");
    expect(h.calls.filter(call => call.action === "stage-source-test")).toHaveLength(1);
    expect(h.calls.filter(call => call.action === "save-source-test")).toHaveLength(0);
  });
});

describe("source-derived default document selection", () => {
  test("posts repeated checkbox fields and verifies uppercase CHECKED attributes", async () => {
    const h = harness();
    expect(await h.documents.defaults(await h.documents.context(), "1", ["101", "102"])).toEqual({ documentIds: ["101", "102"] });
    const calls = h.calls.filter(call => call.action === "defaults-save-source-test");
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as FormData;
    expect(body.getAll("defaultDocs")).toEqual(["101", "102"]);
    expect(body.get("docType")).toBe("1");
    expect(body.get("sourceNonce")).toBe("synthetic-default-nonce");
  });

  test("enforces observed maximum and allowed values before saving", async () => {
    const h = harness();
    await expect(h.documents.defaults(await h.documents.context(), "1", ["101", "102", "103"])).rejects.toThrow("observed site limit");
    await expect(h.documents.defaults(await h.documents.context(), "1", ["missing"])).rejects.toThrow("no longer available");
    expect(h.calls.filter(call => call.action === "defaults-save-source-test")).toHaveLength(0);
  });

  test("read-back mismatch fails without replaying the save", async () => {
    const h = harness({ defaultReadback: ["103"] });
    await expect(h.documents.defaults(await h.documents.context(), "1", ["101", "102"])).rejects.toThrow("not saved as approved");
    expect(h.calls.filter(call => call.action === "defaults-save-source-test")).toHaveLength(1);
  });
});
