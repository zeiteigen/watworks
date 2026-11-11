import { hasHostedCoverSlot, hostedJobPending, WORKING_STATUSES, type HostedJob } from "./hosted-queue.js";
import { openAnswerCount } from "./hosted-answers.js";

/**
 * The plain-language model behind the dashboard. Internal statuses stay underneath;
 * the page only needs who has the ball, which step the job is on, and one verb.
 */
export type TaskKind = "answers" | "resume" | "resume_failed" | "letter" | "letter_failed" | "final" | "uncertain" | "blocked" | "working" | "submitted";
export type TaskOwner = "you" | "watworks" | "done";
export type TaskStep = "answers" | "resume" | "letter" | "final";
export interface HostedTask { owner: TaskOwner; kind: TaskKind; verb: string; step: number; steps: number; minutes: number }

const workingVerbs: Record<string, string> = {
  tailoring_resume: "WatWorks is tailoring your resume",
  drafting_cover_letter: "WatWorks is writing your cover letter",
  uploading: "WatWorks is uploading your documents",
  submitting: "Submitting",
  preparing: "WatWorks is preparing the application",
};

export function taskSteps(job: HostedJob): TaskStep[] {
  const steps: TaskStep[] = ["answers"];
  if (job.customResume) steps.push("resume");
  if (hasHostedCoverSlot(job) || job.coverLetter) steps.push("letter");
  steps.push("final");
  return steps;
}
/** Reasons this application cannot be completed from WatWorks. */
export function taskBlockers(job: HostedJob): string[] {
  const unsupported = (job.form?.questions ?? []).filter(question => question.type === "unsupported").map(question => `WatWorks can't answer “${question.label}”.`);
  return [...(job.form?.blockers ?? []), ...unsupported, ...(job.resumeId ? [] : ["No resume was chosen for this posting."])];
}
export function externalSteps(job: HostedJob): string[] {
  const steps = job.form?.externalSteps;
  return Array.isArray(steps) ? steps.filter((step): step is string => typeof step === "string" && step.trim() !== "") : [];
}

function kindOf(job: HostedJob): TaskKind {
  if (hostedJobPending(job.jobId) || WORKING_STATUSES.includes(job.status)) return "working";
  switch (job.status) {
    case "review": return taskBlockers(job).length ? "blocked" : "answers";
    case "resume_review": return job.customResume ? "resume" : "answers";
    // Without a custom resume there is nothing to retry; the application continues from its answers.
    case "resume_failed": return job.customResume ? "resume_failed" : "answers";
    // An uploaded letter can arrive before the answers are settled; the answers come first.
    case "cover_letter_review": return openAnswerCount(job) ? "answers" : job.coverLetter ? "letter" : "letter_failed";
    case "cover_letter_failed": return "letter_failed";
    case "confirm_required": return "final";
    case "submitted": return "submitted";
    case "uncertain": return "uncertain";
    default: return "blocked";
  }
}
function stepOf(job: HostedJob, kind: TaskKind): TaskStep {
  if (kind === "resume" || kind === "resume_failed" || job.status === "tailoring_resume") return "resume";
  if (kind === "letter" || kind === "letter_failed" || job.status === "drafting_cover_letter") return "letter";
  if (kind === "answers" || kind === "blocked" || job.status === "review") return "answers";
  return "final";
}

export function hostedTask(job: HostedJob): HostedTask {
  const kind = kindOf(job), steps = taskSteps(job), step = Math.max(0, steps.indexOf(stepOf(job, kind))) + 1;
  const base = { kind, step, steps: steps.length };
  switch (kind) {
    case "answers": {
      const open = openAnswerCount(job);
      return { ...base, owner: "you", verb: open ? `Answer ${open} ${open === 1 ? "question" : "questions"}` : "Check your answers", minutes: 1 + open };
    }
    case "resume": return { ...base, owner: "you", verb: "Review your tailored resume", minutes: 2 };
    case "resume_failed": return { ...base, owner: "you", verb: "Your tailored resume didn't build", minutes: 1 };
    case "letter": return { ...base, owner: "you", verb: "Read your cover letter", minutes: 2 };
    case "letter_failed": return { ...base, owner: "you", verb: "Your cover letter didn't build", minutes: 1 };
    case "final": return { ...base, owner: "you", verb: "Check and submit", minutes: 1 };
    case "uncertain": return { ...base, owner: "you", verb: "Check whether it was sent", minutes: 1 };
    case "blocked": return { ...base, owner: "you", verb: "Apply on WaterlooWorks yourself", minutes: 1 };
    case "submitted": return { ...base, owner: "done", step: steps.length, verb: externalSteps(job).length ? "Sent · finish the employer's steps" : "Sent", minutes: 0 };
    default: return { ...base, owner: "watworks", verb: hostedJobPending(job.jobId) ?? workingVerbs[job.status] ?? "WatWorks is working on it", minutes: 0 };
  }
}

const DAY = 86_400_000;
export function deadlineOf(job: HostedJob): number | undefined {
  for (const value of [job.form?.deadline, job.posting?.deadline]) {
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(time)) return time;
  }
  return undefined;
}
/** Only urgent deadlines are worth showing: today and the next three days. */
export function dueLabel(job: HostedJob, now = Date.now()): string | undefined {
  const deadline = deadlineOf(job);
  if (deadline === undefined || deadline < now) return undefined;
  const days = Math.floor((new Date(deadline).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  return days <= 0 ? "due today" : days === 1 ? "due tomorrow" : days <= 3 ? `due in ${days} days` : undefined;
}
/** Most urgent first: an unchecked submission, then the soonest deadline; jobs to finish elsewhere last. */
export function sortTasks(jobs: HostedJob[]): HostedJob[] {
  const rank = (job: HostedJob) => { const kind = hostedTask(job).kind; return kind === "uncertain" ? 0 : kind === "blocked" ? 2 : 1; };
  return [...jobs].sort((a, b) => rank(a) - rank(b) || (deadlineOf(a) ?? Infinity) - (deadlineOf(b) ?? Infinity));
}
export function needsYou(jobs: HostedJob[]): HostedJob[] {
  return sortTasks(jobs.filter(job => job.status !== "dismissed" && hostedTask(job).owner === "you"));
}
