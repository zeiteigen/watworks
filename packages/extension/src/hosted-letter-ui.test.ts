import { expect, test } from "bun:test";
import { letterStep, letterUploadForm } from "./hosted-letter-ui.js";
import type { HostedJob } from "./hosted-queue.js";
import type { StepContext } from "./hosted-step.js";
import { withDom } from "./hosted-test-dom.js";

const slot = { requirements: [{ id: "letter", typeId: "66", role: "attachment", label: "Cover letter" }] };
const hooks = { refresh: () => {}, report: () => {}, progress: () => {} };
function context(started: Array<() => Promise<void>>): StepContext { return { hooks, resumes: [], reviewMode: "line", act: write => { started.push(write); } }; }

test("the letter is read in place and its approval names that exact revision", () => withDom("<main></main>", () => {
  const started: Array<() => Promise<void>> = [];
  const job: HostedJob = { jobId: "1", status: "cover_letter_review", form: slot, coverLetter: { sha256: "a".repeat(64), name: "letter.pdf", texKey: "source" } };
  const step = letterStep(job, context(started));
  expect(step.body.querySelector(".pdf-review")).not.toBeNull();
  expect(step.primary!.textContent).toBe("Approve letter and upload");
  expect(step.primary!.hasAttribute("data-write")).toBe(true);
  expect(step.menu!.map(item => item.textContent)).toEqual(["Upload my own PDF instead", "Download LaTeX source", "Open the PDF in a new tab"]);
  expect(started.length).toBe(0);
  step.primary!.click();
  expect(started.length).toBe(1);
  const tailored = letterStep({ ...job, customResume: { requested: true } }, context([]));
  expect(tailored.primary!.textContent).toBe("Approve letter and tailor resume");
}));

test("a failed draft shows its reason and offers a new draft, never an approval", () => withDom("<main></main>", () => {
  const step = letterStep({ jobId: "failed", status: "cover_letter_failed", coverLetterError: "Your LaTeX template could not be compiled.", form: slot }, context([]));
  expect(step.body.textContent).toContain("Your LaTeX template could not be compiled.");
  expect(step.primary!.textContent).toBe("Ask for a new draft");
}));

test("a picked cover letter survives a re-render", () => withDom("<main></main>", () => {
  const job: HostedJob = { jobId: "keep", status: "review", form: slot };
  const form = letterUploadForm(job, hooks);
  expect(letterUploadForm(job, hooks)).toBe(form);
  form.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = true;
  expect(letterUploadForm(job, hooks).querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(false);
}));
