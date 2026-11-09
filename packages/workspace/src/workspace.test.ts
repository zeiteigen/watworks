import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCoverLetter, buildJobDocument, buildResumeVariant } from "./documents.js";
import { findLatexEngine } from "./latex/compile.js";
import { escapeLatex, inline, renderCoverLetter, renderJobDocument, renderResume, renderResumeBody } from "./latex/render.js";
import { parseJobKey, WorkspacePaths } from "./paths.js";
import { planBlockers } from "./plans.js";
import { JobDocumentSchema, ResumeDocumentSchema } from "./schemas.js";
import { Workspace } from "./store.js";
import type { ApplicationForm } from "../../application-workflow/src/types.js";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "wat-workspace-test-"));
  roots.push(root);
  const value = new Workspace(root);
  await value.scaffold();
  return value;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const profile = {
  name: "Jane Doe", email: "jane@example.com", links: [{ label: "github.com/jane", url: "https://github.com/jane" }],
  workAuthorization: { canada: "citizen", unitedStates: "none", needsSponsorship: { canada: false, unitedStates: true } },
  targets: [{ id: "backend", label: "Backend", keywords: ["backend"], resumeVariant: "swe" }],
};

const resume = {
  heading: { name: "Jane Doe", contacts: [{ text: "jane@example.com", url: "mailto:jane@example.com" }] },
  sections: [
    { kind: "experience", entries: [{ role: "Developer", organization: "Acme & Co", dates: "2025", bullets: ["Cut latency **40%** with C# & $caching_"] }] },
    { kind: "skills", groups: [{ label: "Languages", items: ["C++", "TypeScript"] }] },
  ],
};

const key = { source: "waterlooworks", jobId: "123" };

function form(overrides: Partial<ApplicationForm> = {}): ApplicationForm {
  return {
    accountKey: "a".repeat(64), accountLabel: "Student", jobId: "123", title: "Developer", employer: "Acme", term: "Winter 2027",
    deadline: "2099-01-01T00:00:00Z", canApply: true, hasApplication: false, version: "v1", blockers: [], externalSteps: [],
    requirements: [{ id: "resume", typeId: "1", label: "Resume", required: true, role: "resume" }, { id: "letter", typeId: "2", label: "Cover letter", required: true, role: "attachment" }],
    questions: [{ id: "eligible", label: "Eligible to work in Canada?", type: "single_choice", required: true, options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }],
    ...overrides,
  };
}

describe("LaTeX rendering", () => {
  test("escapes every special character so text cannot inject commands", () => {
    expect(escapeLatex("\\input{/etc/passwd} 100% & $x_1$ #1 ~^<>")).toBe("\\textbackslash{}input\\{/etc/passwd\\} 100\\% \\& \\$x\\_1\\$ \\#1 \\textasciitilde{}\\textasciicircum{}\\textless{}\\textgreater{}");
    expect(inline("a **b_c** d")).toBe("a \\textbf{b\\_c} d");
  });

  test("links cannot reopen TeX through caret notation, braces, or backslashes", () => {
    const render = (url: string) => renderResumeBody(ResumeDocumentSchema.parse({ heading: { name: "N", contacts: [{ text: "site", url }] }, sections: [{ kind: "list", title: "S", items: ["i"] }] }));
    const body = render("https://x.example/^^7d^^7bL^^7d^^5cinput^^7b/etc/passwd^^7d");
    expect(body).not.toContain("^");
    expect(body).toContain("https://x.example/\\%5E\\%5E7d");
    expect(render("https://x.example/a}\\input{b} c")).toContain("https://x.example/a\\%7D\\%5Cinput\\%7Bb\\%7D\\%20c}");
    expect(render("https://x.example/a%20b#c")).toContain("https://x.example/a\\%20b\\#c}");
    expect(render("github.com/jane")).toContain("\\href{github.com/jane}");
    expect(render("tel:+15551234")).toContain("\\href{tel:+15551234}");
    expect(() => render("file:///etc/passwd")).toThrow("Unsupported link scheme");
    expect(() => render("javascript:alert(1)")).toThrow("Unsupported link scheme");
  });

  test("profile links get the same protection", () => {
    const body = renderCoverLetter("%%WAT:SENDER_CONTACT%% %%WAT:BODY%%", { recipient: { company: "C", addressLines: [] }, greeting: "Hi", paragraphs: ["P"], closing: "Bye" }, { name: "N", email: "n@example.com", links: [{ label: "site", url: "https://x.example/^^5cinput" }] });
    expect(body).not.toContain("^");
  });

  test("renders resume sections with Jake's macros", () => {
    const body = renderResumeBody(ResumeDocumentSchema.parse(resume));
    expect(body).toContain("\\resumeHeading{Jane Doe}{\\href{mailto:jane@example.com}{\\underline{jane@example.com}}}");
    expect(body).toContain("\\resumeSubheading{Developer}{2025}{Acme \\& Co}{}");
    expect(body).toContain("\\resumeItem{Cut latency \\textbf{40\\%} with C\\# \\& \\$caching\\_}");
    expect(body).toContain("\\resumeSkillLine{Languages}{C++, TypeScript}");
  });

  test("requires exactly one body marker", () => {
    expect(() => renderResume("no marker", ResumeDocumentSchema.parse(resume))).toThrow("%%WAT:BODY%%");
    expect(renderResume("pre\n%%WAT:BODY%%\npost", ResumeDocumentSchema.parse(resume))).toStartWith("pre\n\\resumeHeading");
  });

  test("fills cover letter markers with escaped values", () => {
    const tex = renderCoverLetter("%%WAT:SENDER_NAME%%|%%WAT:RECIPIENT%%|%%WAT:BODY%%|%%WAT:UNKNOWN%%", {
      date: "Jan 1", recipient: { company: "R&D Inc", addressLines: ["1 Main St"] }, greeting: "Hi,", paragraphs: ["One.", "Two **x**."], closing: "Thanks,",
    }, profile as never);
    expect(tex).toBe("Jane Doe|R\\&D Inc \\\\\n1 Main St|One.\n\nTwo \\textbf{x}.|%%WAT:UNKNOWN%%");
  });
});

describe("job documents", () => {
  test("render sections with escaped paragraphs and bullets", () => {
    const doc = JobDocumentSchema.parse({ title: "Project Summary", sections: [{ heading: "R&D", paragraphs: ["Built **fast** things."], bullets: ["50% faster"] }] });
    const tex = renderJobDocument("%%WAT:TITLE%%|%%WAT:SUBTITLE%%|%%WAT:BODY%%", doc, profile as never);
    expect(tex).toBe("Project Summary||\\docSection{R\\&D}\nBuilt \\textbf{fast} things.\n\n\\docBulletsStart\n  \\item 50\\% faster\n\\docBulletsEnd\n");
    expect(() => JobDocumentSchema.parse({ title: "Empty", sections: [{ heading: "Nothing" }] })).toThrow("paragraphs or bullets");
  });
});

describe("workspace store", () => {
  test("keeps all paths inside data/", () => {
    const paths = new WorkspacePaths("/data");
    expect(() => paths.resume("../evil")).toThrow("Invalid resume variant");
    expect(() => parseJobKey("waterlooworks:../../etc")).toThrow();
    expect(() => parseJobKey("../x:1")).toThrow();
    expect(paths.job(parseJobKey("waterlooworks:123")).plan).toBe("/data/jobs/waterlooworks/123/plan.json");
  });

  test("seeds editable templates without overwriting edits", async () => {
    const ws = await workspace();
    await Bun.write(ws.paths.resumeTemplate, "edited %%WAT:BODY%%");
    await ws.scaffold();
    expect(await readFile(ws.paths.resumeTemplate, "utf8")).toBe("edited %%WAT:BODY%%");
    expect(await readFile(ws.paths.coverLetterTemplate, "utf8")).toContain("%%WAT:BODY%%");
  });

  test("validates the profile and reports field errors", async () => {
    const ws = await workspace();
    await expect(ws.saveProfile({ ...profile, email: "nope" })).rejects.toThrow();
    const saved = await ws.saveProfile(profile);
    expect(saved.preferences.locations).toEqual([]);
    expect(await ws.getProfile()).toEqual(saved);
  });

  test("pending document confirmation can be declined without allowing active or uncertain jobs to be skipped", async () => {
    const ws = await workspace();
    await ws.saveJob(key, { summary: { source: "waterlooworks", jobId: "123", title: "Developer", employer: "Acme", requiredDocuments: [] }, posting: {} }, "# Developer", form());
    for (const state of ["applying", "outcome_unknown", "form_filled", "applied"] as const) {
      await ws.setStatus(key, { state });
      await expect(ws.skipJob(key, "Declined")).rejects.toThrow("cannot be skipped");
    }
    await ws.setStatus(key, { state: "confirm_required" });
    await expect(ws.savePlan(key, { resumeVariant: "swe", fit: "Match" }, [])).rejects.toThrow("can no longer be re-planned");
    expect(await ws.skipJob(key, "User decided not to apply")).toMatchObject({ state: "skipped", reason: "User decided not to apply", removedFromQueueAt: expect.any(String) });
    expect(await ws.getPosting(key)).toBeDefined();
  });

  test("tracks job states; agents cannot re-plan submitted jobs", async () => {
    const ws = await workspace();
    await expect(ws.savePlan(key, {}, [])).rejects.toThrow("Unknown job");
    const summary = { source: "waterlooworks", jobId: "123", title: "Developer", employer: "Acme", requiredDocuments: [] };
    expect((await ws.saveJob(key, { summary, posting: {} }, "# Developer", form())).state).toBe("found");
    const plan = { resumeVariant: "swe", fit: "Strong backend match", rank: 2 };
    expect((await ws.savePlan(key, plan, ["Missing answer"])).status).toMatchObject({ state: "planned", blockers: ["Missing answer"] });
    expect((await ws.savePlan(key, plan, [])).status.state).toBe("ready");
    await ws.setStatus(key, { state: "applied" });
    await expect(ws.savePlan(key, plan, [])).rejects.toThrow("can no longer be re-planned");
    await expect(ws.skipJob(key, "nope")).rejects.toThrow("cannot be skipped");
    expect((await ws.saveJob(key, { summary, posting: {} }, "# Developer")).state).toBe("applied");
    expect((await ws.listJobs({ states: ["applied"] })).map(job => job.key)).toEqual(["waterlooworks:123"]);
  });

});

describe.skipIf(!findLatexEngine())("PDF generation", () => {
  test("compiles one-page resumes and cover letters, and validates plans against the form", async () => {
    const ws = await workspace();
    await ws.saveProfile(profile);
    const built = await buildResumeVariant(ws, { variant: "swe", label: "Software", resume });
    expect(built.pages).toBe(1);
    expect(built.warnings).toEqual([]);
    expect((await readFile(built.pdf)).subarray(0, 5).toString()).toBe("%PDF-");

    await ws.saveJob(key, { summary: { source: "waterlooworks", jobId: "123", title: "Developer", employer: "Acme", requiredDocuments: [] }, posting: {} }, "", form());
    const plan = { resumeVariant: "swe", fit: "Good", attachments: [{ kind: "cover_letter", requirementId: "letter" }], answers: [{ questionId: "eligible", value: "y" }] } as const;
    expect(await planBlockers(ws, key, { ...plan, caveats: [], attachments: [...plan.attachments], answers: [...plan.answers] }, form())).toContain("Attachment letter: Document is not accessible");
    await buildCoverLetter(ws, key, { recipient: { company: "Acme" }, paragraphs: ["I build backends."] });
    expect(await planBlockers(ws, key, { ...plan, caveats: [], attachments: [...plan.attachments], answers: [...plan.answers] }, form())).toEqual([]);
    expect(await planBlockers(ws, key, { ...plan, caveats: [], attachments: [...plan.attachments], answers: [{ questionId: "eligible", value: "maybe" }] }, form())).toContain("Invalid answer: Eligible to work in Canada?");

    const summary = await buildJobDocument(ws, key, "project-summary", { title: "Project Summary", subtitle: "For Acme", sections: [{ heading: "wat-mcp", paragraphs: ["An MCP server."], bullets: ["TypeScript & Bun"] }] });
    expect(summary.pages).toBe(1);
    expect((await ws.listJobDocuments(key)).map(doc => [doc.id, doc.kind])).toEqual([["cover-letter", "cover_letter"], ["project-summary", "document"]]);
    const withDocument = { ...plan, caveats: [], answers: [...plan.answers], attachments: [{ kind: "document" as const, requirementId: "letter", document: "project-summary" }] };
    expect(await planBlockers(ws, key, withDocument, form())).toEqual([]);
    expect((await ws.listJobs())[0]?.documents.map(doc => doc.id)).toEqual(["cover-letter", "project-summary"]);
  }, 300_000);
});

describe("stray directory entries", () => {
  test("do not fail job, document, or resume listings", async () => {
    const value = await workspace();
    const key = { source: "waterlooworks", jobId: "123" };
    await value.saveJob(key, { summary: { source: key.source, jobId: key.jobId, title: "T", employer: "E", requiredDocuments: [] }, posting: {} }, "d");
    const stray = [join(value.paths.jobsDir, ".DS_Store"), join(value.paths.jobsDir, "waterlooworks", ".DS_Store"), join(value.paths.jobsDir, "waterlooworks", "123.bak"), join(value.paths.resumesDir, ".DS_Store"), join(value.paths.job(key).documentsDir, "Bad Name.json")];
    await mkdir(value.paths.job(key).documentsDir, { recursive: true });
    for (const path of stray) await writeFile(path, "{}");
    expect((await value.listJobs()).map(job => job.key)).toEqual(["waterlooworks:123"]);
    expect(await value.listResumeVariants()).toEqual([]);
    expect(await value.listJobDocuments(key)).toEqual([]);
  });
});
