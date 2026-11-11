import { hostedRequest, HostedRejection } from "./hosted-client.js";
import type { HostedCustomResume } from "./hosted-resume-ui.js";

export interface HostedJob {
  jobId: string;
  status: string;
  reason?: string;
  resumeId?: string;
  answers?: Array<{ questionId: string; value: unknown }>;
  missingFacts?: string[];
  posting?: { title?: string; organization?: string; employer?: string; [key: string]: unknown };
  form?: { blockers?: string[]; questions?: ScreeningQuestion[]; [key: string]: unknown };
  manifest?: unknown;
  manifestHash?: string;
  operation?: unknown;
  coverLetter?: {sha256:string;name:string;texKey?:string;source?:string};
  customResume?: HostedCustomResume;
  customResumeError?: string;
  processedCoverLetter?: {sha256:string;name:string};
  coverLetterError?: string;
  /** Saved by the server when a write was turned away before reaching WaterlooWorks. */
  lastAttemptError?: { message: string; at: number };
}
export interface ScreeningQuestion {
  id: string; label: string; type: "text" | "number" | "boolean" | "single_choice" | "multiple_choice" | "unsupported";
  required: boolean; options?: Array<{ id: string; label: string }>; maxLength?: number; min?: number; max?: number;
}
export interface HostedQueueData { jobs: HostedJob[]; runs: Array<{ status?: string }> }
/** Errors are shown loudly; everything else is a quiet status line. */
export type Tone = "info" | "error";
/** `jobId` names the job a message is about, so a page showing that job can show it there instead. */
type StatusMessage = (value: string, tone?: Tone, jobId?: string) => void;
export interface JobNotice { text: string; tone: Tone }
/** What a write needs from the page: a read-only refresh, a status line, and a redraw while it runs. */
export interface WriteHooks { refresh: () => void | Promise<void>; report: StatusMessage; progress: () => void }

/** WatWorks is doing something with these; the page only reads until they settle. */
export const WORKING_STATUSES = ["reserved", "running", "executing", "preparing", "uploading", "submitting", "drafting_cover_letter", "tailoring_resume"];
export function hostedQueueNeedsPolling(data: HostedQueueData): boolean {
  return data.jobs.some(job => job.status === "confirm_required" || WORKING_STATUSES.includes(job.status)) || data.runs.some(run => ["reserved", "running"].includes(run.status ?? ""));
}
export function hasHostedCoverSlot(job: HostedJob): boolean {
  const requirements = job.form?.requirements;
  return Array.isArray(requirements) && requirements.some(slot => slot.role === "attachment" && (slot.typeId === "66" || /^cover\s*letter$/i.test(slot.label ?? "")));
}
export function hostedPreparationMessage(status?: string, detail?: string): string {
  if (status === "resume_review") return "Your tailored resume is ready to review.";
  if (status === "resume_failed") return detail || "The tailored resume could not be built. Try again or send your base resume.";
  if (status === "cover_letter_review") return "Your cover letter is ready to read.";
  if (status === "confirm_required") return "Ready for your final check.";
  if (status === "cover_letter_failed") return detail || "The cover letter could not be built. Ask for a new draft or upload your own PDF.";
  return "The outcome needs checking. Look on WaterlooWorks before doing anything else.";
}
export function jobTitle(job: HostedJob): string { return job.posting?.title || `Posting ${job.jobId}`; }
export function jobEmployer(job: HostedJob): string { return job.posting?.organization || job.posting?.employer || `WaterlooWorks posting ${job.jobId}`; }

async function prepareSession(): Promise<void> {
  const reply = await chrome.runtime.sendMessage({ type: "prepareHostedSubmissionSession" });
  if (!reply?.ok) throw new HostedRejection(reply?.error ?? "Could not prepare your WaterlooWorks session.");
}

/** Writes requested from this page; each one-use approval is clicked at most once per page load. */
const attemptedWrites = new Set<string>();
/** Jobs with a write in flight from this page; survives the re-renders driven by polling. */
const pendingJobs = new Map<string, string>();
const jobNotices = new Map<string, JobNotice>();
export function hostedJobPending(jobId: string): string | undefined { return pendingJobs.get(jobId); }
export function hostedJobNotice(jobId: string): JobNotice | undefined { return jobNotices.get(jobId); }
export function hostedWriteAttempted(job: HostedJob, kind: "review" | "confirm_required"): boolean { return attemptedWrites.has(`${job.jobId}:${kind}`); }

type WriteResult = string | JobNotice | undefined;
async function runJobWrite(job: HostedJob, busyText: string, hooks: WriteHooks, write: () => Promise<WriteResult>): Promise<void> {
  if (pendingJobs.has(job.jobId)) return;
  const say = (notice: JobNotice) => { jobNotices.set(job.jobId, notice); hooks.report(`${jobTitle(job)}: ${notice.text}`, notice.tone, job.jobId); };
  pendingJobs.set(job.jobId, busyText); jobNotices.delete(job.jobId); hooks.report(`${jobTitle(job)}: ${busyText}`); void hooks.refresh();
  try { const done = await write(); if (done) say(typeof done === "string" ? { text: done, tone: "info" } : done); }
  catch (error) { say({ text: error instanceof Error ? error.message : String(error), tone: "error" }); }
  finally { pendingJobs.delete(job.jobId); await hooks.refresh(); }
}

/** Keep read-only status refreshes running while the single approved write is outstanding. */
async function trackProgress<T>(job: HostedJob, phase: string, hooks: WriteHooks, write: () => Promise<T>): Promise<T> {
  const previous = job.status;
  job.status = phase; hooks.progress();
  const timer = setInterval(() => { void hooks.refresh(); }, 1500);
  try { return await write(); }
  finally { clearInterval(timer); job.status = previous; void hooks.refresh(); }
}

/** The phase a preparation request runs through, so the page can say what WatWorks is doing. */
function preparePhase(job: HostedJob): string {
  const tailoring = Boolean(job.customResume && !job.customResume.approved && job.status !== "resume_review");
  return tailoring ? "tailoring_resume" : hasHostedCoverSlot(job) && !job.coverLetter ? "drafting_cover_letter" : job.status === "resume_review" && job.coverLetter ? "preparing" : "uploading";
}
async function prepare(job: HostedJob, hooks: WriteHooks, body: Record<string, string>): Promise<JobNotice> {
  await prepareSession();
  const result = await trackProgress<{status?: string; error?: string}>(job, preparePhase(job), hooks, () => hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/prepare`, { method: "POST", body: JSON.stringify(body) }));
  const failed = ["resume_failed", "cover_letter_failed", "uncertain"].includes(result.status ?? "") || !result.status;
  return { text: hostedPreparationMessage(result.status, result.error), tone: failed ? "error" : "info" };
}

/** Approves the application from its answers: saves edited answers first when there are any. */
export function approveAnswers(job: HostedJob, hooks: WriteHooks, edited?: { answers: Array<{questionId: string; value: unknown}>; factAnswers: Array<{question: string; value: unknown}> }): Promise<void> {
  const key = `${job.jobId}:review`;
  if (!job.coverLetter) {
    if (attemptedWrites.has(key)) return Promise.resolve();
    attemptedWrites.add(key);
  }
  return runJobWrite(job, job.coverLetter ? "Saving your answers…" : "Saving your answers and starting the application…", hooks, async () => {
    try {
      if (edited) {
        // The server re-reads the form from WaterlooWorks to validate answers, so it needs a live session first.
        await prepareSession();
        await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/answers`, { method: "POST", body: JSON.stringify({ ...edited, resolvedMissingFacts: true }) });
        if (job.coverLetter) return "Answers saved. Read and approve your cover letter next.";
      }
      return await prepare(job, hooks, {});
    } catch (error) {
      // A definite rejection ran nothing, so the approval can be offered again.
      if (error instanceof HostedRejection) { attemptedWrites.delete(key); throw error; }
      throw new Error(`${error instanceof Error ? error.message : String(error)} Check its status before taking another action.`);
    }
  });
}
/** Saves edited answers without approving anything; used once a letter is already attached. */
export function saveAnswers(job: HostedJob, hooks: WriteHooks, edited: { answers: Array<{questionId: string; value: unknown}>; factAnswers: Array<{question: string; value: unknown}> }): Promise<void> {
  return runJobWrite(job, "Saving your answers…", hooks, async () => {
    await prepareSession();
    await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/answers`, { method: "POST", body: JSON.stringify({ ...edited, resolvedMissingFacts: true }) });
    return "Answers saved.";
  });
}
/** Approves a reviewed document revision (or asks for a new draft without one) and continues preparation. */
export function approveDocument(job: HostedJob, hooks: WriteHooks, approval: { customResumeHash?: string; coverLetterHash?: string }): Promise<void> {
  return runJobWrite(job, "Continuing the application…", hooks, () => prepare(job, hooks, approval as Record<string, string>));
}
/** Submits exactly the manifest shown in the final check. Never retried from this page. */
export function confirmSubmission(job: HostedJob, hooks: WriteHooks): Promise<void> {
  const key = `${job.jobId}:confirm_required`;
  if (attemptedWrites.has(key) || !job.manifestHash) return Promise.resolve();
  attemptedWrites.add(key);
  return runJobWrite(job, "Submitting… Do not retry if the result is uncertain.", hooks, async () => {
    try {
      await prepareSession();
      const outcome = await trackProgress(job, "submitting", hooks, () => hostedRequest<{status?: string}>(`/jobs/${encodeURIComponent(job.jobId)}/confirm`, { method: "POST", body: JSON.stringify({ manifestHash: job.manifestHash }) }));
      return outcome.status === "submitted" ? "Submitted." : { text: "The outcome needs checking. Look on WaterlooWorks before doing anything else.", tone: "error" };
    } catch (error) {
      if (error instanceof HostedRejection) { attemptedWrites.delete(key); throw error; }
      throw new Error(`${error instanceof Error ? error.message : String(error)} Do not submit again until you have checked WaterlooWorks.`);
    }
  });
}

export function launchHostedSearch(report: StatusMessage, onRefresh: () => void, postingId?: string): () => Promise<boolean> {
  return async () => {
    report("Preparing your WaterlooWorks session…");
    try { await prepareSession(); await hostedRequest("/launch", { method: "POST", body: JSON.stringify(postingId ? { postingId } : {}) }); report(postingId ? `Posting ${postingId} is being prepared. It will appear here when ready.` : "Today's search started. New matches will appear here."); await onRefresh(); return true; }
    catch (error) { report(error instanceof Error ? error.message : String(error), "error"); return false; }
  };
}
