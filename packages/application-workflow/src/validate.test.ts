import { describe, expect, test } from "bun:test";
import { parseApplicationPage } from "../../waterlooworks-client/src/application-page.js";
import { applicationWizard } from "../../waterlooworks-client/test/application-fixtures.js";
import { validateApplication } from "./validate.js";
import type { ApplicationForm, ApplicationInput, LibraryDocument, PreparedFile } from "./types.js";

function fixture() {
  const resume: LibraryDocument = { id: "resume-1", typeId: "1", name: "Resume", revision: "c".repeat(64), state: "ready", source: "library" };
  const transcript: LibraryDocument = { ...resume, id: "transcript", typeId: "3", name: "Transcript", source: "system" };
  const form: ApplicationForm = {
    accountKey: "a".repeat(64), accountLabel: "Student", jobId: "123", title: "Developer", employer: "Example", term: "Winter 2027",
    deadline: "2099-01-01T00:00:00Z", canApply: true, hasApplication: false, version: "v1", blockers: [], externalSteps: ["Complete employer questionnaire"],
    requirements: [
      { id: "resume", typeId: "1", label: "Resume", required: true, role: "resume" },
      { id: "letter", typeId: "2", label: "Cover letter", required: true, role: "attachment" },
      { id: "transcript", typeId: "3", label: "Transcript", required: true, role: "system", selectedDocument: transcript },
    ], questions: [{ id: "authorized", label: "Authorized?", type: "boolean", required: true }],
  };
  const input: ApplicationInput = { jobId: "123", resumeDocumentId: resume.id, attachments: [{ requirementId: "letter", filePath: "/allowed/letter.pdf" }], answers: [{ questionId: "authorized", value: false }] };
  const file: PreparedFile = { filename: "letter.pdf", size: 100, sha256: "b".repeat(64), bytes: new Uint8Array(100) };
  const files = new Map([["letter", file]]);
  return { form, input, resume, files, run: () => validateApplication(form, input, [resume], files) };
}

describe("application schema validation", () => {
  test("validates the observed checkbox widget as a required group, including a No answer", async () => {
    const f = fixture();
    const screening = await Bun.file(new URL("../../waterlooworks-client/test/fixtures/screening-checkboxes.html", import.meta.url)).text();
    f.form.questions = parseApplicationPage(applicationWizard(false, false).replace("</form>", screening + "</form>")).questions;
    f.input.answers = [];
    expect(f.run().blockers).toEqual(f.form.questions.map(question => `Missing answer: ${question.label}`));
    f.input.answers = f.form.questions.map(question => ({ questionId: question.id, value: ["No"] }));
    expect(f.run().blockers).toEqual([]);
    expect(f.run().manifest?.answers.map(answer => answer.value)).toEqual([["No"], ["No"]]);
    f.input.answers[0]!.value = [];
    expect(f.run().blockers).toEqual([`Missing answer: ${f.form.questions[0]!.label}`]);
    f.input.answers[0]!.value = ["Unknown"];
    expect(f.run().blockers).toEqual([`Invalid answer: ${f.form.questions[0]!.label}`]);
  });

  test("accepts false and binds exact document revisions, hashes, and external steps", () => {
    const f = fixture();
    const result = f.run();
    expect(result.blockers).toEqual([]);
    expect(result.manifest?.answers[0]?.value).toBe(false);
    expect(result.manifest?.documents[0]?.document?.revision).toBe(f.resume.revision);
    expect(result.manifest?.documents[1]?.file?.sha256).toBe("b".repeat(64));
    expect(result.manifest?.externalSteps).toEqual(f.form.externalSteps);
    expect(JSON.stringify(result.manifest)).not.toContain("/allowed/");
    expect(JSON.stringify(result.manifest)).not.toContain('"bytes"');
  });

  test("blocks missing and extraneous document slots and duplicate selections", () => {
    const f = fixture();
    f.files.clear();
    expect(f.run().blockers).toContain("Missing document: Cover letter");
    f.input.attachments.push({ requirementId: "unknown", filePath: "/other.pdf" });
    expect(f.run().blockers).toContain("Unsupported attachment slot: unknown");
    f.input.attachments.push({ ...f.input.attachments[0]! });
    expect(f.run().blockers).toContain("Duplicate document attachment");
    f.form.requirements.push({ ...f.form.requirements[0]! });
    expect(f.run().blockers).toContain("Duplicate document requirement IDs");
    expect(f.run().manifest).toBeUndefined();
  });

  test("omits optional system slots with no selection but blocks required ones", () => {
    const f = fixture();
    const slot = f.form.requirements[2]!;
    delete slot.selectedDocument;
    expect(f.run().blockers).toContain("Document is missing, changed, or not ready: Transcript");
    slot.required = false;
    const result = f.run();
    expect(result.blockers).toEqual([]);
    expect(result.manifest?.documents.map(item => item.requirementId)).toEqual(["resume", "letter"]);
  });

  test("blocks missing, extraneous, duplicate, and ill-typed answers", () => {
    const f = fixture();
    f.input.answers = [];
    expect(f.run().blockers).toContain("Missing answer: Authorized?");
    f.input.answers = [{ questionId: "authorized", value: "false" }, { questionId: "unknown", value: "extra" }, { questionId: "unknown", value: "duplicate" }];
    expect(f.run().blockers).toEqual(expect.arrayContaining(["Invalid answer: Authorized?", "Unknown question: unknown", "Duplicate answer: unknown"]));
  });

  test("requires active conditional answers and rejects answers for inactive questions", () => {
    const f = fixture();
    f.form.questions.push({ id: "explanation", label: "Explanation", type: "text", required: true, condition: { questionId: "authorized", equals: true } });
    expect(f.run().manifest).toBeDefined();
    f.input.answers.push({ questionId: "explanation", value: "Extra" });
    expect(f.run().blockers).toContain("Answer supplied for inactive question: Explanation");
    f.input.answers = [{ questionId: "authorized", value: true }];
    expect(f.run().blockers).toContain("Missing answer: Explanation");
    f.input.answers.push({ questionId: "explanation", value: "Provided" });
    expect(f.run().manifest?.answers).toHaveLength(2);
    f.form.questions[1]!.condition = { questionId: "missing", equals: true };
    expect(f.run().blockers).toContain("Unsupported question condition: Explanation");
  });

  test("validates choices, numeric bounds, text limits, and unknown question types", () => {
    const f = fixture();
    f.form.questions = [
      { id: "choice", label: "Choice", type: "single_choice", required: true, options: [{ id: "yes", label: "Yes please" }] },
      { id: "many", label: "Many", type: "multiple_choice", required: true, options: [{ id: "a", label: "Option A" }] },
      { id: "number", label: "Number", type: "number", required: true, min: 0, max: 1 },
      { id: "text", label: "Text", type: "text", required: true, maxLength: 2 },
    ];
    f.input.answers = [{ questionId: "choice", value: "yes" }, { questionId: "many", value: ["a"] }, { questionId: "number", value: 0 }, { questionId: "text", value: "ok" }];
    expect(f.run().manifest?.answers.map(answer => answer.displayValue)).toEqual(["Yes please", ["Option A"], 0, "ok"]);
    f.input.answers = [{ questionId: "choice", value: "Yes please" }, { questionId: "many", value: ["a", "a"] }, { questionId: "number", value: Infinity }, { questionId: "text", value: "long" }];
    expect(f.run().blockers).toHaveLength(4);
    f.form.questions.push({ id: "unknown", label: "Unknown", type: "unsupported", required: false });
    expect(f.run().blockers).toContain("Unsupported question: Unknown");
  });

  test.each(["processing", "archived", "unknown"] as const)("rejects %s library documents", state => {
    const f = fixture();
    f.resume.state = state;
    expect(f.run().blockers).toContain("Document is missing, changed, or not ready: Resume");
  });

  test("respects native number step constraints instead of submitting fractional values", () => {
    const f = fixture();
    f.form.questions = [{ id: "years", label: "Years", type: "number", required: true, integer: true, min: 0 }];
    f.input.answers = [{ questionId: "years", value: 1.5 }];
    expect(f.run().blockers).toContain("Invalid answer: Years");
    f.input.answers[0]!.value = 2;
    expect(f.run().manifest).toBeDefined();
    f.form.questions[0]!.integer = false;
    f.input.answers[0]!.value = 1.5;
    expect(f.run().manifest).toBeDefined();
  });

  test("rejects document type and source mismatch", () => {
    const f = fixture();
    f.resume.typeId = "different-type";
    expect(f.run().manifest).toBeUndefined();
    f.resume.typeId = "1";
    f.resume.source = "system";
    expect(f.run().manifest).toBeUndefined();
    f.resume.source = "library";
    f.form.requirements[2]!.selectedDocument!.source = "library";
    expect(f.run().blockers).toContain("Document is missing, changed, or not ready: Transcript");
  });

  test.each(["2020-01-01T00:00:00Z", "2099-01-01", "not a date"])("blocks an expired or ambiguous deadline %s", deadline => {
    const f = fixture();
    f.form.deadline = deadline;
    expect(f.run().blockers).toContain("Application deadline is unknown or has passed");
  });

  test("blocks closed postings, existing applications, and incomplete identity", () => {
    const f = fixture();
    f.form.canApply = false;
    expect(f.run().manifest).toBeUndefined();
    f.form.canApply = true;
    f.form.hasApplication = true;
    expect(f.run().manifest).toBeUndefined();
    f.form.hasApplication = false;
    f.form.accountKey = "raw-account";
    expect(f.run().blockers).toContain("Verified account identity is unavailable");
  });
});
