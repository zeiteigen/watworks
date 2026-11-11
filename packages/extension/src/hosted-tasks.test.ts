import { expect, test } from "bun:test";
import { dueLabel, hostedTask, needsYou, taskSteps } from "./hosted-tasks.js";
import type { HostedJob } from "./hosted-queue.js";

const letterSlot = { requirements: [{ role: "attachment", typeId: "66", label: "Cover letter" }] };
const job = (status: string, extra: Partial<HostedJob> = {}): HostedJob => ({ jobId: status, status, resumeId: "r", ...extra });

test("every status reads as who has the ball and one plain verb", () => {
  const cases: Array<[HostedJob, string, string, string]> = [
    [job("review", { form: { questions: [{ id: "q", label: "Eligible?", type: "boolean", required: true }] } }), "you", "answers", "Answer 1 question"],
    [job("review", { form: { questions: [{ id: "q", label: "Eligible?", type: "boolean", required: true }] }, answers: [{ questionId: "q", value: true }] }), "you", "answers", "Check your answers"],
    [job("review", { form: { blockers: ["Transcript required"] } }), "you", "blocked", "Apply on WaterlooWorks yourself"],
    [job("review", { form: { questions: [{ id: "q", label: "Draw it", type: "unsupported", required: true }] } }), "you", "blocked", "Apply on WaterlooWorks yourself"],
    [job("tailoring_resume", { customResume: { requested: true } }), "watworks", "working", "WatWorks is tailoring your resume"],
    [job("resume_review", { customResume: { requested: true } }), "you", "resume", "Review your tailored resume"],
    [job("resume_failed", { customResume: { requested: true } }), "you", "resume_failed", "Your tailored resume didn't build"],
    [job("drafting_cover_letter", { form: letterSlot }), "watworks", "working", "WatWorks is writing your cover letter"],
    [job("cover_letter_review", { form: letterSlot, coverLetter: { sha256: "a", name: "l.pdf" } }), "you", "letter", "Read your cover letter"],
    [job("cover_letter_failed", { form: letterSlot }), "you", "letter_failed", "Your cover letter didn't build"],
    [job("uploading"), "watworks", "working", "WatWorks is uploading your documents"],
    [job("confirm_required"), "you", "final", "Check and submit"],
    [job("submitting"), "watworks", "working", "Submitting"],
    [job("uncertain"), "you", "uncertain", "Check whether it was sent"],
    [job("submitted"), "done", "submitted", "Sent"],
    [job("submitted", { form: { externalSteps: ["Finish the online assessment"] } }), "done", "submitted", "Sent · finish the employer's steps"],
    [job("something_new"), "you", "blocked", "Apply on WaterlooWorks yourself"],
  ];
  for (const [input, owner, kind, verb] of cases) expect(hostedTask(input)).toMatchObject({ owner, kind, verb });
});

test("an uploaded letter waits behind unanswered questions", () => {
  const task = hostedTask(job("cover_letter_review", { form: letterSlot, coverLetter: { sha256: "a", name: "l.pdf" }, missingFacts: ["Which term are you available?"] }));
  expect(task).toMatchObject({ kind: "answers", verb: "Answer 1 question", step: 1, steps: 3 });
});

test("steps include only what this posting needs", () => {
  expect(taskSteps(job("review"))).toEqual(["answers", "final"]);
  expect(taskSteps(job("review", { form: letterSlot, customResume: { requested: true } }))).toEqual(["answers", "resume", "letter", "final"]);
  expect(hostedTask(job("cover_letter_review", { form: letterSlot, customResume: { requested: true }, coverLetter: { sha256: "a", name: "l.pdf" } }))).toMatchObject({ step: 3, steps: 4 });
  expect(hostedTask(job("confirm_required", { form: letterSlot }))).toMatchObject({ step: 3, steps: 3 });
});

test("only urgent deadlines are labelled, and the most urgent task comes first", () => {
  const now = new Date("2026-11-10T09:00:00").getTime(), at = (day: string) => ({ deadline: `2026-11-${day}T23:59:00` });
  expect(dueLabel(job("review", { form: at("10") }), now)).toBe("due today");
  expect(dueLabel(job("review", { form: at("11") }), now)).toBe("due tomorrow");
  expect(dueLabel(job("review", { form: at("13") }), now)).toBe("due in 3 days");
  expect(dueLabel(job("review", { form: at("20") }), now)).toBeUndefined();
  const order = needsYou([
    { ...job("review", { form: { ...at("20"), blockers: ["Transcript"] } }), jobId: "blocked" },
    { ...job("confirm_required", { form: at("20") }), jobId: "later" },
    { ...job("confirm_required", { form: at("12") }), jobId: "sooner" },
    { ...job("uncertain"), jobId: "check" },
    { ...job("uploading"), jobId: "working" },
    { ...job("dismissed"), jobId: "gone" },
  ]).map(item => item.jobId);
  expect(order).toEqual(["check", "sooner", "later", "blocked"]);
});
