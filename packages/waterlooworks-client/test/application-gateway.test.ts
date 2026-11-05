import { describe, expect, test } from "bun:test";
import type { ApplicationManifest, PreparedFile } from "../../application-workflow/src/types.js";
import { validateApplication } from "../../application-workflow/src/validate.js";
import { WaterlooWorksApplicationGateway } from "../src/application-gateway.js";
import type { FetchLike } from "../src/session.js";
import { applicationOverview, applicationPdf, applicationSession, applicationWizard, attachmentPdf, documentsPage, inventoryPage, inventoryRow, pdfHash, preparedAttachment } from "./application-fixtures.js";

const jobsPage = await Bun.file(new URL("./fixtures/jobs-page.html", import.meta.url)).text() + `<script>function createApplication(){const request={action:'fake-create'};}</script>`;
interface Call { path: string; method: string; action: string; body?: URLSearchParams | FormData }
interface Settings {
  screening?: boolean;
  logoutAction?: string;
  attachment?: boolean;
  digestMismatch?: boolean;
  eligibilityChanged?: boolean;
  method?: string;
  expressedIntention?: boolean;
  commitFailure?: "invalid" | "missing-id" | "http" | "lost";
  readbackApplied?: boolean;
}

function server(settings: Settings = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  let commitAttempted = false;
  let stage = "review";
  let savedAttachment = false;
  let storedPdf: Uint8Array = attachmentPdf;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const raw = init?.body;
    if (raw !== undefined && !(raw instanceof URLSearchParams) && !(raw instanceof FormData)) throw new Error("Unsupported test request body");
    const body = (raw ?? (url.search ? url.searchParams : undefined)) as URLSearchParams | FormData | undefined;
    const action = String(body?.get("action") ?? "GET");
    calls.push({ path, method: init?.method ?? "GET", action, ...(body ? { body } : {}) });
    events.push(action);
    const html = (source: string, status = 200) => new Response(source, { status, headers: { "content-type": "text/html; charset=UTF-8" } });
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=UTF-8" } });
    if (stage === "submit" && action === settings.logoutAction) return new Response(null, { status: 302 });
    if (action === "GET") return html(path.endsWith("documents.htm") ? documentsPage + (settings.attachment ? `<a onclick="buildForm({action:'fake-upload-entry',ownerId:'1234'})"><span>Upload</span></a><a onclick="buildForm({action:'fake-docOwnerStats',docTypeId:'70'})">Portfolio</a>` : "") : jobsPage);
    if (action === "fake-docOwnerStats") {
      const typeId = String(body?.get("docTypeId") ?? "67");
      return html(inventoryPage.replace("docTypeId:'67'", `docTypeId:'${typeId}'`));
    }
    if (action === "fake-grid") {
      const typeId = String(body?.get("docTypeId") ?? "67");
      if (typeId === "70" && savedAttachment) return html(inventoryRow.replaceAll("100", "200").replace("Sample Resume", "portfolio.pdf").replace("Resume", "Portfolio"));
      return html(typeId === "67" ? inventoryRow : "<table></table>");
    }
    if (action === "fake-preview") {
      const docId = body?.get("docId");
      const bytes = docId === "200" ? (settings.digestMismatch ? applicationPdf : storedPdf) : applicationPdf;
      return json({ doc: Buffer.from(bytes).toString("base64") });
    }
    if (action === "fake-data-action-for-tests") return json({
      postingId: "12345", position: "Sample Co-op", organization: "Example Employer", workTerm: "2027 - Winter", deadline: "2099-10-22T13:00:00Z", hasPreScreening: settings.screening ?? false,
      applicationData: { canApply: !(settings.eligibilityChanged && stage === "submit" && calls.filter(call => call.action === action).length > 1), hasApplication: commitAttempted && settings.readbackApplied !== false },
    });
    if (action === "fake-overview-action-for-tests") return html(applicationOverview(settings.method));
    if (action === "fake-create") return json({ canApply: true, hasApplication: false, expressedIntention: settings.expressedIntention ?? false, form: { action: "fake-open-wizard", postingId: "12345" } });
    if (action === "fake-open-wizard") return html(applicationWizard(settings.screening ?? false, settings.attachment ?? false));
    if (action === "fake-stage-attachment") return json({ uuid: "fake-upload-uuid" });
    if (action === "fake-save-attachment") { savedAttachment = true; return json({ docId: 200 }); }
    if (action === "fake-commit") {
      commitAttempted = true;
      if (settings.commitFailure === "lost") throw new TypeError("Simulated lost response");
      if (settings.commitFailure === "http") return html("Server failed", 500);
      if (settings.commitFailure === "invalid") return json({ valid: false, naId: 900 });
      if (settings.commitFailure === "missing-id") return json({ valid: true });
      return json({ valid: true, naId: 900 });
    }
    if (action === "fake-confirm") return html("<p>Application submitted confirmation</p>");
    throw new Error(`Unexpected fake request: ${path} ${action}`);
  };
  const gateway = new WaterlooWorksApplicationGateway({ getSession: async () => applicationSession }, fetchImpl);
  return { gateway, calls, events, setStoredPdf(bytes: Uint8Array) { storedPdf = bytes; }, beginSubmit() { calls.length = 0; events.length = 0; stage = "submit"; } };
}

async function approval(fake: ReturnType<typeof server>, settings: Settings = {}): Promise<{ manifest: ApplicationManifest; files: Map<string, PreparedFile> }> {
  const form = await fake.gateway.getApplicationForm("12345");
  expect(form.blockers).toEqual([]);
  const resume = await fake.gateway.getDocument("100");
  const files = new Map<string, PreparedFile>(settings.attachment ? [["70", preparedAttachment]] : []);
  const validated = validateApplication(form, { jobId: "12345", resumeDocumentId: "100", attachments: settings.attachment ? [{ requirementId: "70", filePath: "snapshot" }] : [], answers: settings.screening ? [{ questionId: "question_term", value: "yes" }, { questionId: "question_updates", value: false }, { questionId: "question_skills", value: ["ts", "py"] }] : [] }, [resume], files);
  expect(validated.blockers).toEqual([]);
  if (!validated.manifest) throw new Error("Fixture could not produce approval");
  fake.beginSubmit();
  return { manifest: validated.manifest, files };
}

describe("WaterlooWorksApplicationGateway request contracts", () => {
  test("loads full-cycle forms with and without static pre-screen questions", async () => {
    for (const screening of [false, true]) {
      const fake = server({ screening });
      const form = await fake.gateway.getApplicationForm("12345");
      expect(form.blockers).toEqual([]);
      expect(form.questions).toHaveLength(screening ? 3 : 0);
      expect(form.requirements.find(slot => slot.role === "system")?.selectedDocument?.state).toBe("ready");
      expect(form.externalSteps).toEqual(["Complete the optional employer survey."]);
      expect(fake.calls.every(call => call.path.endsWith("documents.htm") || call.path.endsWith("jobs.htm"))).toBe(true);
    }
  });

  test.each(["GET", "fake-docOwnerStats", "fake-grid", "fake-preview", "fake-data-action-for-tests", "fake-open-wizard"])("logout during %s preflight is proven safe before writes", async logoutAction => {
    const fake = server({ logoutAction });
    const { manifest, files } = await approval(fake);
    const error = await fake.gateway.withMutationTracking(() => fake.gateway.submitApplication(manifest, files, () => {})).catch(error => error);
    expect(error.name).toBe("ReviewBeforeMutationError");
    expect(fake.calls.some(call => ["fake-commit", "fake-stage-attachment", "fake-save-attachment"].includes(call.action))).toBe(false);
  });

  test.each(["fake-stage-attachment", "fake-save-attachment", "fake-commit", "fake-confirm"])("logout during or after %s remains uncertain", async logoutAction => {
    const fake = server({ logoutAction, attachment: true });
    const { manifest, files } = await approval(fake, { attachment: true });
    const error = await fake.gateway.withMutationTracking(() => fake.gateway.submitApplication(manifest, files, () => {})).catch(error => error);
    expect(error.name).not.toBe("ReviewBeforeMutationError");
    expect(fake.calls.some(call => call.action === "fake-stage-attachment")).toBe(true);
  });

  test("encodes reviewed document IDs and answers and calls the boundary immediately before commit", async () => {
    const fake = server({ screening: true });
    const { manifest, files } = await approval(fake, { screening: true });
    let boundaries = 0;
    const receipt = await fake.gateway.submitApplication(manifest, files, () => { boundaries++; fake.events.push("boundary"); });
    expect(boundaries).toBe(1);
    expect(fake.events.indexOf("fake-commit")).toBe(fake.events.indexOf("boundary") + 1);
    const body = fake.calls.find(call => call.action === "fake-commit")?.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(body)).toMatchObject({ applyOption: "customPkg", name: "Sample Package", postingId: "12345", uiForm: "true", wizardMode: "true", "67": "100", "71": "300", question_term: "yes", isSpiralRobot: "true" });
    expect(body.has("question_updates")).toBe(false);
    expect(body.getAll("question_skills[]")).toEqual(["ts", "py"]);
    expect(body.has("question_skills")).toBe(false);
    expect(receipt).toMatchObject({ applicationId: "900", jobId: "12345", status: "submitted" });
    expect(fake.calls.filter(call => call.action === "fake-commit")).toHaveLength(1);
    expect(fake.events.indexOf("fake-confirm")).toBeGreaterThan(fake.events.indexOf("fake-commit"));
  });

  test("stages per-job attachments, saves without changing defaults, verifies PDF bytes, then commits", async () => {
    const fake = server({ attachment: true });
    const { manifest, files } = await approval(fake, { attachment: true });
    await fake.gateway.submitApplication(manifest, files, () => fake.events.push("boundary"));
    const stage = fake.calls.find(call => call.action === "fake-stage-attachment")!;
    const save = fake.calls.find(call => call.action === "fake-save-attachment")!;
    expect(stage.path).toBe("/myAccount/co-op/full/jobs.htm");
    expect(stage.body).toBeInstanceOf(FormData);
    const upload = stage.body?.get("upload") as File;
    expect(upload.name).toBe("portfolio.pdf");
    expect(Buffer.from(await upload.arrayBuffer())).toEqual(Buffer.from(attachmentPdf));
    expect(stage.body?.get("uploadDirectory")).toBe("");
    expect(Object.fromEntries(save.body!)).toMatchObject({ postingId: "12345", uiForm: "true", docType: "70", docName: "portfolio.pdf", docUploaded: "fake-upload-uuid", removeFile_docUpload: "false" });
    expect(save.body?.has("defaultDoc")).toBe(false);
    expect(fake.events.indexOf("fake-save-attachment")).toBeGreaterThan(fake.events.indexOf("fake-stage-attachment"));
    expect(fake.events.indexOf("boundary")).toBeGreaterThan(fake.events.indexOf("fake-save-attachment"));
    expect(fake.calls.find(call => call.action === "fake-commit")?.body?.get("70")).toBe("200");
  });

  test("reviews a transformed staged PDF and final submission binds its fresh stored snapshot without reupload", async () => {
    const fake = server({ attachment: true });
    const { manifest, files } = await approval(fake, { attachment: true });
    fake.setStoredPdf(applicationPdf);
    const staged = await fake.gateway.stageAttachments(manifest, files);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.document).toMatchObject({ id: "200", typeId: "70", name: "portfolio.pdf", revision: pdfHash(applicationPdf), state: "ready" });
    expect(staged[0]!.bytes).toEqual(applicationPdf);
    expect(staged[0]!.document.revision).not.toBe(preparedAttachment.sha256);
    expect(fake.calls.filter(call => call.action === "fake-commit")).toHaveLength(0);

    const reviewed = structuredClone(manifest);
    reviewed.documents.find(item => item.requirementId === "70")!.storedDocument = staged[0]!.document;
    let boundaries = 0;
    await fake.gateway.submitApplication(reviewed, files, () => { boundaries++; }, staged);
    const commit = fake.calls.find(call => call.action === "fake-commit")!;
    expect(boundaries).toBe(1);
    expect(commit.body?.get("70")).toBe("200");
    expect(fake.calls.filter(call => call.action === "fake-stage-attachment")).toHaveLength(1);
    expect(fake.calls.filter(call => call.action === "fake-save-attachment")).toHaveLength(1);
    expect(fake.calls.filter(call => call.action === "fake-preview" && call.body?.get("docId") === "200")).toHaveLength(3);
  });

  test("rejects a changed stored digest after review before the final boundary", async () => {
    const fake = server({ attachment: true });
    const { manifest, files } = await approval(fake, { attachment: true });
    fake.setStoredPdf(applicationPdf);
    const staged = await fake.gateway.stageAttachments(manifest, files);
    const reviewed = structuredClone(manifest);
    reviewed.documents.find(item => item.requirementId === "70")!.storedDocument = staged[0]!.document;
    fake.setStoredPdf(attachmentPdf);
    let boundaries = 0;
    await expect(fake.gateway.submitApplication(reviewed, files, () => { boundaries++; }, staged)).rejects.toThrow("Stored PDF changed after review");
    expect(boundaries).toBe(0);
    expect(fake.calls.filter(call => call.action === "fake-commit")).toHaveLength(0);
    expect(fake.calls.filter(call => call.action === "fake-stage-attachment")).toHaveLength(1);
    expect(fake.calls.filter(call => call.action === "fake-save-attachment")).toHaveLength(1);
    expect(fake.calls.filter(call => call.action === "fake-preview" && call.body?.get("docId") === "200")).toHaveLength(3);
  });

  test("stops before commit when staged PDF bytes differ from approval", async () => {
    const fake = server({ attachment: true, digestMismatch: true });
    const { manifest, files } = await approval(fake, { attachment: true });
    let boundaries = 0;
    await expect(fake.gateway.submitApplication(manifest, files, () => { boundaries++; })).rejects.toThrow("Stored attachment differs from approved bytes");
    expect(boundaries).toBe(0);
    expect(fake.calls.filter(call => call.action === "fake-save-attachment")).toHaveLength(1);
    expect(fake.calls.filter(call => call.action === "fake-commit")).toHaveLength(0);
  });

  test("stops when authoritative eligibility changes during staging", async () => {
    const fake = server({ eligibilityChanged: true, attachment: true });
    const { manifest, files } = await approval(fake, { attachment: true });
    let boundaries = 0;
    await expect(fake.gateway.submitApplication(manifest, files, () => { boundaries++; })).rejects.toThrow("Posting became unavailable during staging");
    expect(boundaries).toBe(0);
    expect(fake.calls.filter(call => call.action === "fake-commit")).toHaveLength(0);
  });

  test("never retries a rejected, incomplete, failed or lost commit response", async () => {
    for (const commitFailure of ["invalid", "missing-id", "http", "lost"] as const) {
      const fake = server({ commitFailure });
      const { manifest, files } = await approval(fake);
      let boundaries = 0;
      await expect(fake.gateway.submitApplication(manifest, files, () => { boundaries++; })).rejects.toThrow();
      expect(boundaries).toBe(1);
      expect(fake.calls.filter(call => call.action === "fake-commit")).toHaveLength(1);
      expect(fake.calls.filter(call => call.action === "fake-confirm")).toHaveLength(0);
    }
  });

  test("requires an authoritative applied readback after a valid receipt", async () => {
    const fake = server({ readbackApplied: false });
    const { manifest, files } = await approval(fake);
    await expect(fake.gateway.submitApplication(manifest, files, () => {})).rejects.toThrow("Application receipt could not be reconciled");
    expect(fake.calls.filter(call => call.action === "fake-commit")).toHaveLength(1);
    expect(fake.calls.filter(call => call.action === "fake-confirm")).toHaveLength(0);
  });

  test("does not send an intention action for external or expressed-intention routes", async () => {
    for (const settings of [{ method: "Employer Website" }, { expressedIntention: true }]) {
      const fake = server(settings);
      await expect(fake.gateway.getApplicationForm("12345")).rejects.toThrow();
      expect(fake.calls.filter(call => call.action === "fake-open-wizard")).toHaveLength(0);
      expect(fake.calls.filter(call => call.action === "fake-commit")).toHaveLength(0);
      expect(fake.calls.every(call => !/intention/i.test(call.action))).toBe(true);
    }
  });
});
