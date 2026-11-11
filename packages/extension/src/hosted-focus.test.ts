import { afterEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createFocusView } from "./hosted-focus.js";
import type { HostedWorkspace } from "./hosted-client.js";
import type { HostedJob } from "./hosted-queue.js";

const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous);
  else Reflect.deleteProperty(globalThis, "document");
});
const soon = new Date(Date.now() + 2 * 86_400_000).toISOString(), later = new Date(Date.now() + 20 * 86_400_000).toISOString();
const profile = { roles: ["Developer"], citizenshipCountries: [], permanentResidencyCountries: [], fluentLanguages: [], canada: "unknown" as const, unitedStates: "unknown" as const, minimumHourlyPay: null, locations: [], notes: "", scheduleHour: 7, workTerm: "", eightMonthEligible: "unknown" as const };
const longAnswer = "At Fernhill I rewrote the ingest service in Go with a bounded worker pool, and it went from 40 to 900 requests per second without dropping writes.";
const jobs: HostedJob[] = [
  { jobId: "101", status: "review", resumeId: "r", posting: { title: "Backend developer", organization: "Northwind" }, form: { deadline: later, questions: [
    { id: "q1", label: "Describe a concurrent system", type: "text", required: true },
    { id: "q2", label: "Can you commute?", type: "boolean", required: true },
  ] }, answers: [{ questionId: "q1", value: longAnswer }] },
  { jobId: "102", status: "confirm_required", resumeId: "r", manifestHash: "a".repeat(64), posting: { title: "Designer", organization: "Lumen" }, form: { deadline: soon },
    manifest: { title: "Designer", employer: "Lumen", documents: [{ label: "Resume", document: { name: "Resume.pdf" } }], answers: [{ question: "Eligible to work in Canada?", displayValue: "Yes" }] } },
  { jobId: "103", status: "submitted", posting: { title: "Analyst", organization: "Fernhill" }, form: { externalSteps: ["Finish the online assessment"] } },
  { jobId: "104", status: "uploading", posting: { title: "Platform intern", organization: "Cobalt" } },
  { jobId: "105", status: "uncertain", posting: { title: "QA developer", organization: "Orchard" } },
];
async function fixture(overrides: Partial<HostedWorkspace> = {}) {
  const dom = parseHTML(await Bun.file(`${import.meta.dir}/hosted.html`).text()), { document } = dom;
  // linkedom's select has a read-only value.
  Object.defineProperty(dom.window.HTMLSelectElement.prototype, "value", { configurable: true,
    get(this: HTMLSelectElement) { return [...this.options].find(option => option.selected)?.value ?? this.options[0]?.value ?? ""; },
    set(this: HTMLSelectElement, value: string) { for (const option of this.options) option.selected = option.value === value; } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const show = createFocusView(document as unknown as Document, () => {}, () => {});
  const workspace: HostedWorkspace = { profile, resumes: [{ id: "r", name: "Software resume", size: 1 }], runs: [], ai: { available: true, connected: true, reason: "" }, jobs, ...overrides };
  show(workspace);
  const $ = (selector: string) => document.querySelector<HTMLElement>(selector)!;
  const buttons = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].filter(item => item.textContent === text);
  return { document, show, workspace, $, buttons, click: (selector: string) => $(selector).click(), visible: (selector: string) => !$(selector).hidden };
}

test("home says only how much needs you, and the review starts with the most urgent task", async () => {
  const f = await fixture();
  expect(f.$("#home-heading").textContent).toBe("3 things need you · about 4 minutes");
  expect(f.$("#quiet-toggle").textContent).toBe("WatWorks is preparing 1 more · 1 step left on employer sites · 1 sent");
  f.click("#start-review");
  expect(f.visible("#session-screen")).toBe(true);
  expect(f.$("#session-count").textContent).toBe("1 of 3");
  // An unchecked submission comes first, and it can never be submitted again from here.
  expect(f.$("#task-stage .task-title").textContent).toBe("QA developer");
  expect(f.$("#task-stage").textContent).toContain("Do not submit it again");
  expect(f.document.querySelector("#task-stage .job-confirm")).toBeNull();
  f.buttons("Skip for now")[0]!.click();
  expect(f.$("#task-stage .task-title").textContent).toBe("Designer");
});

test("the final check lists everything it sends beside one Submit for that one job", async () => {
  const f = await fixture();
  f.click("#start-review"); f.buttons("Skip for now")[0]!.click();
  const card = f.$("#task-stage .task-card");
  for (const phrase of ["Resume.pdf", "Eligible to work in Canada?", "Yes", "due in 2 days"]) expect(card.textContent).toContain(phrase);
  const submit = card.querySelectorAll<HTMLButtonElement>(".job-confirm");
  expect(submit.length).toBe(1);
  expect(submit[0]!.textContent).toBe("Submit application to Lumen");
  expect(submit[0]!.hasAttribute("data-write")).toBe(true);
});

test("answers open only what needs you and show every filled answer in full", async () => {
  const f = await fixture();
  f.click("#start-review"); f.buttons("Skip for now")[0]!.click(); f.buttons("Skip for now")[0]!.click();
  const card = f.$("#task-stage .task-card");
  expect(card.querySelector(".step-heading")!.textContent).toBe("1 question needs you");
  expect(card.querySelectorAll(".open-questions select").length).toBe(1);
  expect(card.querySelector(".filled-answers")!.textContent).toContain(longAnswer);
  expect(card.textContent).not.toContain("I reviewed these answers");
  const primary = f.buttons("These answers are right, continue")[0]!;
  primary.click();
  const notice = card.querySelector<HTMLElement>(".task-notice.error")!;
  expect(notice.getAttribute("role")).toBe("alert");
  expect(notice.textContent).toBe("That didn’t go throughAnswer the open questions above to continue.");
  expect(f.$("#task-stage .task-title").textContent).toBe("Backend developer");
});

test("refreshes leave an unchanged card alone, new tasks join the end, and finished ones offer Next", async () => {
  const f = await fixture();
  f.click("#start-review");
  const card = f.$("#task-stage .task-card");
  f.show({ ...f.workspace, jobs: [...jobs, { jobId: "106", status: "confirm_required", manifestHash: "b".repeat(64), manifest: {}, posting: { title: "New one" } }] });
  expect(f.$("#task-stage .task-card")).toBe(card);
  expect(f.$("#session-count").textContent).toBe("1 of 4");
  expect(f.$("#session-arrived").textContent).toBe("1 new task added to the end");
  f.show({ ...f.workspace, jobs: jobs.map(job => job.jobId === "105" ? { ...job, status: "submitted" } : job) });
  expect(f.$("#task-stage .task-card")).not.toBe(card);
  expect(f.buttons("Next").length).toBe(1);
  expect(f.buttons("Skip for now").length).toBe(0);
});

test("the review ends with a summary, and All jobs opens one job with a way back", async () => {
  const f = await fixture();
  f.click("#start-review");
  for (let index = 0; index < 3; index++) f.buttons("Skip for now")[0]!.click();
  expect(f.visible("#done-screen")).toBe(true);
  expect(f.$("#done-summary").textContent).toContain("3 tasks are still waiting for you.");
  f.click('.nav [data-screen="jobs"]');
  const groups = [...f.document.querySelectorAll("#job-groups summary")].map(item => item.textContent);
  expect(groups).toEqual(["Needs you · 3", "WatWorks is on it · 1", "Sent · 1"]);
  [...f.document.querySelectorAll<HTMLButtonElement>(".job-row")].find(row => row.textContent?.includes("Analyst"))!.click();
  expect(f.$("#task-stage").textContent).toContain("Finish the online assessment");
  expect(f.$("#session-count").textContent).toBe("");
  f.buttons("Back to all jobs")[0]!.click();
  expect(f.visible("#jobs-screen")).toBe(true);
});

test("a first visit opens Setup on what is missing, without onboarding tabs or a work term field", async () => {
  const f = await fixture({ profile: null, resumes: [], jobs: [], ai: { available: false, connected: false, reason: "" } });
  expect(f.visible("#setup-screen")).toBe(true);
  expect(f.$("#setup-intro").textContent).toBe("3 things are missing before WatWorks can apply for you.");
  for (const section of ["connections", "profile", "resumes"]) expect(f.$(`[data-section="${section}"]`).hasAttribute("open")).toBe(true);
  expect(f.$('[data-section="prompts"]').hasAttribute("open")).toBe(false);
  expect(f.document.querySelector("#profile-form [name=eightMonthEligible]")).not.toBeNull();
  expect(f.document.querySelector('[name="workTerm"]')).toBeNull();
  expect(f.visible("#ai-alert")).toBe(true);
  expect(f.document.querySelector("[data-tab]")).toBeNull();
});

test("a reason the server saved for a turned-away submission shows on the card and in All jobs", async () => {
  const message = "Nothing was sent. Another WatWorks action was still using your WaterlooWorks session. Details: “An operation is active”. You can try again.";
  const f = await fixture({ jobs: jobs.map(job => job.jobId === "102" ? { ...job, lastAttemptError: { message, at: 1 } } : job) });
  f.click("#start-review"); f.buttons("Skip for now")[0]!.click();
  const notice = f.$("#task-stage .task-notice.error");
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toBe(`That didn’t go through${message}`);
  // The Submit button is still offered: the server proved nothing was sent.
  expect(f.$("#task-stage .job-confirm").textContent).toBe("Submit application to Lumen");
  f.click('.nav [data-screen="jobs"]');
  const row = [...f.document.querySelectorAll<HTMLButtonElement>(".job-row")].find(item => item.textContent?.includes("Designer"))!;
  expect(row.querySelector(".row-problem")!.textContent).toBe("Last attempt didn’t go through");
});
