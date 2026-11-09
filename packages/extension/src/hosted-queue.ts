import { appendHostedLetter, hasHostedCoverSlot, hostedPreparationMessage } from './hosted-letter-ui.js';
import { appendHostedJobActions } from "./hosted-job-actions.js";
import { hostedRequest, HostedRejection, type HostedResume } from "./hosted-client.js";
import { factQuestionId } from "../../shared/src/missing-facts.js";
import { hostedDialog } from "./hosted-dialog.js";
import { appendCustomResume, type HostedCustomResume } from "./hosted-resume-ui.js";
import type { ResumeReviewMode } from "../../shared/src/resume-changes.js";

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
}
export interface ScreeningQuestion {
  id: string; label: string; type: "text" | "number" | "boolean" | "single_choice" | "multiple_choice" | "unsupported";
  required: boolean; options?: Array<{ id: string; label: string }>; maxLength?: number; min?: number; max?: number;
}
export interface HostedQueueData { jobs: HostedJob[]; runs: Array<{ status?: string }> }
type StatusMessage = (value: string) => void;
const attemptedWrites = new Set<string>();
const answerDrafts = new Map<string, { answers: Map<string, unknown>; facts: Map<string, unknown>; reviewed: boolean }>();

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "Not provided";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function detailList(title: string, values: string[]): HTMLElement {
  const section = document.createElement("section"), heading = document.createElement("h4"), list = document.createElement("ul");
  section.className = "job-detail"; heading.textContent = title; section.appendChild(heading);
  for (const value of values) { const row = document.createElement("li"); row.textContent = value; list.appendChild(row); }
  section.appendChild(list); return section;
}
function button(label: string, action: () => void): HTMLButtonElement {
  const result = document.createElement("button"); result.type = "button"; result.textContent = label; result.addEventListener("click", action); return result;
}
function active(status: string): boolean { return ["reserved", "running", "executing", "confirm_required", "preparing", "uploading", "submitting", "drafting_cover_letter", "tailoring_resume"].includes(status); }
export function hostedQueueNeedsPolling(data: HostedQueueData): boolean {
  return data.jobs.some(job => active(job.status)) || data.runs.some(run => ["reserved", "running"].includes(run.status ?? ""));
}
async function prepareSession(): Promise<void> {
  const reply = await chrome.runtime.sendMessage({ type: "prepareHostedSubmissionSession" });
  if (!reply?.ok) throw new HostedRejection(reply?.error ?? "Could not prepare your WaterlooWorks session.");
}

interface ManifestDocument { label?: string; document?: { name?: string; revision?: string }; storedDocument?: { name?: string; revision?: string }; file?: { filename?: string; sha256?: string } }
interface ManifestAnswer { question?: string; displayValue?: unknown }
interface ReviewManifest { title?: string; employer?: string; term?: string; deadline?: string; documents?: ManifestDocument[]; answers?: ManifestAnswer[] }
function manifestReview(raw: unknown): HTMLElement {
  const manifest = raw && typeof raw === "object" ? raw as ReviewManifest : {}, section = document.createElement("section"), heading = document.createElement("h4"), list = document.createElement("dl");
  section.className = "manifest-review"; heading.textContent = "Review application details"; section.appendChild(heading);
  const field = (name: string, value: unknown) => { if (value === undefined || value === null || value === "") return; const term = document.createElement("dt"), description = document.createElement("dd"); term.textContent = name; description.textContent = valueText(value); list.appendChild(term); list.appendChild(description); };
  field("Position", manifest.title); field("Employer", manifest.employer); field("Term", manifest.term); field("Application deadline", manifest.deadline);
  section.appendChild(list);
  const documents = document.createElement("section"), docsHeading = document.createElement("h5"), docList = document.createElement("ul");
  docsHeading.textContent = "Documents"; documents.className = "manifest-documents"; documents.appendChild(docsHeading);
  for (const item of manifest.documents ?? []) {
    const row = document.createElement("li"), name = item.document ?? item.storedDocument, label = document.createElement("strong"), summary = document.createElement("span");
    label.textContent = item.label || "Application document";
    summary.textContent = name?.name || item.file?.filename || "No document listed";
    row.appendChild(label); row.appendChild(summary);
    const revision = name?.revision ?? item.file?.sha256;
    if (revision) { const details = document.createElement("details"), summaryNode = document.createElement("summary"), code = document.createElement("code"); summaryNode.textContent = "Document revision"; code.textContent = revision; details.appendChild(summaryNode); details.appendChild(code); row.appendChild(details); }
    docList.appendChild(row);
  }
  documents.appendChild(docList); section.appendChild(documents);
  const answers = document.createElement("section"), answersHeading = document.createElement("h5"), answerList = document.createElement("dl");
  answersHeading.textContent = "Screening answers"; answers.className = "manifest-answers"; answers.appendChild(answersHeading);
  for (const answer of manifest.answers ?? []) { const question = document.createElement("dt"), value = document.createElement("dd"); question.textContent = answer.question || "Screening question"; value.textContent = valueText(answer.displayValue); answerList.appendChild(question); answerList.appendChild(value); }
  answers.appendChild(answerList); section.appendChild(answers); return section;
}

function questionEditor(question: ScreeningQuestion, initial: unknown, title = question.label, notes: string[] = []): { section: HTMLElement; read: () => unknown } {
  const section = document.createElement("label"), heading = document.createElement("span");
  section.className = "screening-question"; heading.className = "screening-label"; heading.textContent = title;
  const requirement = document.createElement("span"); requirement.className = "hint"; requirement.textContent = question.required ? " · required" : " · optional"; heading.appendChild(requirement);
  section.appendChild(heading);
  for (const note of notes) { const hint = document.createElement("span"); hint.className = "screening-note"; hint.textContent = note; section.appendChild(hint); }
  const select = document.createElement("select"), input = document.createElement("input"), textarea = document.createElement("textarea");
  const blank = document.createElement("option"); blank.value = ""; blank.textContent = "Choose an answer";
  if (question.type === "text") {
    textarea.value = typeof initial === "string" ? initial : ""; if (question.maxLength !== undefined) textarea.maxLength = question.maxLength;
    textarea.setAttribute("aria-label", question.label); section.appendChild(textarea);
    return { section, read: () => textarea.value.trim() || undefined };
  }
  if (question.type === "number") {
    input.type = "number"; input.value = typeof initial === "number" ? String(initial) : ""; input.setAttribute("aria-label", question.label);
    if (question.min !== undefined) input.min = String(question.min); if (question.max !== undefined) input.max = String(question.max);
    input.step = "any"; section.appendChild(input);
    return { section, read: () => input.value === "" || !Number.isFinite(input.valueAsNumber) ? undefined : input.valueAsNumber };
  }
  if (question.type === "boolean") {
    select.appendChild(blank); const yes = document.createElement("option"), no = document.createElement("option");
    yes.value = "true"; yes.textContent = "Yes"; no.value = "false"; no.textContent = "No"; select.appendChild(yes); select.appendChild(no);
    select.value = typeof initial === "boolean" ? String(initial) : ""; select.setAttribute("aria-label", question.label); section.appendChild(select);
    return { section, read: () => select.value === "" ? undefined : select.value === "true" };
  }
  if (question.type === "single_choice") {
    select.appendChild(blank); for (const option of question.options ?? []) { const item = document.createElement("option"); item.value = option.id; item.textContent = option.label; select.appendChild(item); }
    select.value = typeof initial === "string" ? initial : ""; select.setAttribute("aria-label", question.label); section.appendChild(select);
    return { section, read: () => select.value || undefined };
  }
  if (question.type === "multiple_choice") {
    const checks: Array<{ input: HTMLInputElement; id: string }> = [], selected = new Set(Array.isArray(initial) ? initial.filter((v): v is string => typeof v === "string") : []);
    for (const option of question.options ?? []) { const row = document.createElement("span"), check = document.createElement("input"), label = document.createElement("span"); check.type = "checkbox"; check.value = option.id; check.checked = selected.has(option.id); label.textContent = option.label; row.className = "check-option"; row.appendChild(check); row.appendChild(label); section.appendChild(row); checks.push({ input: check, id: option.id }); }
    return { section, read: () => { const values = checks.filter(item => item.input.checked).map(item => item.id); return values.length ? values : undefined; } };
  }
  const unsupported = document.createElement("span"); unsupported.className = "unsupported-question"; unsupported.textContent = "This question type cannot be answered here. It needs manual review."; section.appendChild(unsupported);
  return { section, read: () => undefined };
}

/** Missing facts written as `questionId: note` belong under that question instead of a separate prompt. */
export function linkMissingFacts(questions: ScreeningQuestion[], facts: string[]): { linked: Map<string, string[]>; linkedFacts: Map<string, string>; open: string[] } {
  const ids = new Set(questions.map(question => question.id)), linked = new Map<string, string[]>(), linkedFacts = new Map<string, string>(), open: string[] = [];
  for (const fact of new Set(facts)) {
    const id = factQuestionId(fact, ids);
    if (id !== undefined) { linked.set(id, [...(linked.get(id) ?? []), fact.slice(fact.indexOf(":") + 1).trim()]); linkedFacts.set(fact, id); }
    else open.push(fact);
  }
  return { linked, linkedFacts, open };
}
/** WaterlooWorks pairs some choices with a comment box under the same label; show it as a follow-up. */
function questionTitle(question: ScreeningQuestion, previous?: ScreeningQuestion): string {
  return previous && question.type === "text" && previous.label.trim() === question.label.trim() ? "Additional details for the question above" : question.label;
}
function displayAnswer(question: ScreeningQuestion | undefined, value: unknown): string {
  const option = (id: unknown) => question?.options?.find(item => item.id === id)?.label ?? String(id);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(option).join(", ");
  if (typeof value === "string" && question?.options) return option(value);
  return valueText(value);
}

/** Jobs with a write in flight from this page; survives the re-renders driven by polling. */
const pendingJobs = new Map<string, string>();
const jobNotices = new Map<string, string>();
async function runJobWrite(job: HostedJob, busyText: string, refresh: () => void | Promise<void>, report: StatusMessage, write: () => Promise<string | undefined>): Promise<void> {
  if (pendingJobs.has(job.jobId)) return;
  pendingJobs.set(job.jobId, busyText); jobNotices.delete(job.jobId); report(busyText); void refresh();
  try { const done = await write(); if (done) { jobNotices.set(job.jobId, done); report(done); } }
  catch (error) { const text = error instanceof Error ? error.message : String(error); jobNotices.set(job.jobId, text); report(text); }
  finally { pendingJobs.delete(job.jobId); await refresh(); }
}
export function hostedJobPending(jobId: string): boolean { return pendingJobs.has(jobId); }

export function renderHostedQueue(
  container: HTMLElement, jobs: HostedJob[], resumes: HostedResume[], canLaunch: boolean,
  onRefresh: () => void, report: StatusMessage, onProgress: () => void = () => {}, resumeReview: ResumeReviewMode = "line",
): void {
  container.replaceChildren();
  if (!jobs.length) {
    const empty = document.createElement("p"); empty.textContent = "No prepared postings yet. Your daily matches and specific posting preparations will appear here."; container.appendChild(empty); return;
  }
  const resumeNames = new Map(resumes.map(resume => [resume.id, resume.name]));
  for (const job of jobs) {
    const pending = pendingJobs.get(job.jobId);
    const card = document.createElement("article"), header = document.createElement("div"), title = document.createElement("h3"), status = document.createElement("span");
    card.className = "card job-card"; header.className = "job-card-heading"; title.className = "job-title";
    title.textContent = job.posting?.title || `Posting ${job.jobId}`;
    status.className = `state job-status status-${job.status.replace(/[^a-z0-9_-]/gi, "")}`; status.textContent = job.status.replaceAll("_", " ");
    header.appendChild(title); header.appendChild(status); card.appendChild(header);
    const employer = document.createElement("p"); employer.className = "job-employer"; employer.textContent = job.posting?.organization || job.posting?.employer || `WaterlooWorks posting ${job.jobId}`; card.appendChild(employer);
    if (job.reason) { const reason = document.createElement("p"); reason.className = "job-reason"; reason.textContent = job.reason; card.appendChild(reason); }
    // Everything the employer will receive stays together on the card.
    const documents = document.createElement("section"); documents.className = "job-documents";
    if (job.resumeId) {
      const resume = document.createElement("p"), preview = button("Preview selected resume", async () => {
        preview.disabled = true;
        try {
          const blob = await hostedRequest<Blob>(`/resumes/${encodeURIComponent(job.resumeId!)}`);
          const url = URL.createObjectURL(blob); await chrome.tabs.create({ url }); setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
        } catch (error) { report(error instanceof Error ? error.message : String(error)); }
        finally { preview.disabled = false; }
      });
      resume.className = "job-resume"; resume.textContent = `${job.customResume && !job.customResume.approved ? "Base resume" : "Selected resume"}: ${resumeNames.get(job.resumeId) ?? "Resume unavailable"}`; documents.appendChild(resume); preview.className = "secondary resume-preview"; documents.appendChild(preview);
    }
    const tailoring = Boolean(job.customResume && !job.customResume.approved && job.status !== "resume_review");
    const phase = tailoring ? "tailoring_resume" : hasHostedCoverSlot(job) && !job.coverLetter ? "drafting_cover_letter" : job.status === "resume_review" && job.coverLetter ? "preparing" : "uploading";
    const prepare = (body: string) => async () => {
      await prepareSession();
      const result = await trackProgress<{status?: string; error?: string}>(job, phase, onProgress, onRefresh, () => hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/prepare`, { method: "POST", body }));
      return hostedPreparationMessage(result.status, result.error);
    };
    appendCustomResume(documents, job, resumeReview, onRefresh, report, hash => runJobWrite(job, "Preparing the application…", onRefresh, report, prepare(JSON.stringify(hash ? { customResumeHash: hash } : {}))), Boolean(pending));
    appendHostedLetter(documents,job,onRefresh,report,hash=>runJobWrite(job,"Preparing the application…",onRefresh,report,prepare(JSON.stringify(hash?{coverLetterHash:hash}:{}))));
    if (documents.childElementCount) card.appendChild(documents);
    appendHostedJobActions(card, job, onRefresh, report);
    const actions = card.querySelector<HTMLElement>(".job-actions") ?? card;
    const questions = job.form?.questions ?? [];
    const { linked, linkedFacts, open: openFacts } = linkMissingFacts(questions, job.missingFacts ?? []);
    const blockers = job.form?.blockers ?? [];
    if (blockers.length) card.appendChild(detailList("Application form blockers", blockers));
    const unsupportedQuestions = questions.filter(question => question.type === "unsupported");
    if (unsupportedQuestions.length) card.appendChild(detailList("Needs manual review", unsupportedQuestions.map(question => question.label)));
    const needsInput = (job.missingFacts ?? []).length;
    if (questions.length || needsInput) {
      const editable = ["review", "cover_letter_review"].includes(job.status);
      const body = document.createElement("div"); body.className = "screening-editor";
      const modal = hostedDialog(editable ? "Answer screening questions" : "Screening answers", body);
      const answerById = new Map((job.answers ?? []).map(answer => [answer.questionId, answer.value]));
      if (editable) {
        const form = document.createElement("form");
        const draft = answerDrafts.get(job.jobId);
        const controls = questions.map((question, index) => ({ question, ...questionEditor(question, draft ? draft.answers.get(question.id) : answerById.get(question.id), questionTitle(question, questions[index - 1]), linked.get(question.id)) }));
        for (const control of controls) form.appendChild(control.section);
        const facts = openFacts.map((question, index) => ({question, ...questionEditor({id: `fact-${index}`, label: question, type: "text", required: true, maxLength: 5000}, draft?.facts.get(question))}));
        if (facts.length) { const factsHeading = document.createElement("h4"); factsHeading.textContent = "We also need from you"; form.appendChild(factsHeading); }
        for (const fact of facts) form.appendChild(fact.section);
        const reviewedLabel = document.createElement("label"), reviewed = document.createElement("input"), reviewedText = document.createElement("span");
        reviewed.type = "checkbox"; reviewed.checked = draft?.reviewed ?? false; reviewedText.textContent = "I reviewed these answers and supplied the missing information."; reviewedLabel.className = "reviewed-confirmation"; reviewedLabel.appendChild(reviewed); reviewedLabel.appendChild(reviewedText); form.appendChild(reviewedLabel);
        const saveDraft = () => answerDrafts.set(job.jobId, { answers: new Map(controls.map(control => [control.question.id, control.read()])), facts: new Map(facts.map(fact => [fact.question, fact.read()])), reviewed: reviewed.checked });
        form.addEventListener("input", saveDraft); form.addEventListener("change", saveDraft);
        const consent = document.createElement("p"); consent.className = "meta"; consent.textContent = job.customResume && !job.customResume.approved ? "Saving answers approves this application for drafting your custom resume. You will review its changes before anything is uploaded." : hasHostedCoverSlot(job) ? "Saving answers approves this application for cover-letter drafting. You will review the letter before any application uploads." : "Saving answers also approves uploading the selected resume. You will review the final application before confirming submission."; form.appendChild(consent);
        const formError = document.createElement("p"); formError.className = "form-error"; formError.setAttribute("role", "alert"); form.appendChild(formError);
        const save = document.createElement("button"); save.type = "submit"; save.className = "job-action"; save.dataset.write = ""; save.textContent = job.coverLetter ? "Save reviewed answers" : "Save answers and prepare application"; form.appendChild(save);
        form.addEventListener("submit", event => {
          event.preventDefault();
          if (pendingJobs.has(job.jobId)) return;
          if (!reviewed.checked) { formError.textContent = "Review the answers and check the confirmation before saving."; return; }
          const answers = controls.flatMap(({ question, read }) => { const value = read(); return value === undefined ? [] : [{ questionId: question.id, value }]; });
          const factAnswers: Array<{question: string; value: unknown}> = facts.map(fact => ({question: fact.question, value: fact.read()}));
          if (factAnswers.some(fact => !fact.value)) { formError.textContent = "Answer each question under “We also need from you” before continuing."; return; }
          // Question-linked facts are resolved by the linked answer itself, which is what gets remembered.
          for (const fact of linkedFacts.keys()) factAnswers.push({question: fact, value: null});
          modal.close();
          void runJobWrite(job, job.coverLetter ? "Saving your answers…" : "Saving your answers and preparing the application…", onRefresh, report, async () => {
            // The server re-reads the form from WaterlooWorks to validate answers, so it needs a live session first.
            await prepareSession();
            await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/answers`, { method: "POST", body: JSON.stringify({ answers, factAnswers, resolvedMissingFacts: true }) });
            answerDrafts.delete(job.jobId);
            if (job.coverLetter) return 'Answers saved. Preview and approve your cover letter before uploads.';
            return await prepare("{}")();
          });
        });
        body.appendChild(form);
      } else {
        const list = document.createElement("dl");
        for (const question of questions) { const term = document.createElement("dt"), value = document.createElement("dd"); term.textContent = question.label; value.textContent = answerById.has(question.id) ? displayAnswer(question, answerById.get(question.id)) : "Not answered"; list.append(term, value); }
        body.appendChild(list);
      }
      const answered = questions.filter(question => answerById.has(question.id)).length;
      const openButton = button(editable ? `Answer screening questions (${answered}/${questions.length} answered${needsInput ? ` · ${needsInput} need you` : ""})` : "View screening answers", modal.open);
      openButton.className = editable && needsInput ? "screening-open needs-input" : "secondary screening-open"; openButton.setAttribute("aria-haspopup", "dialog");
      actions.appendChild(openButton); card.appendChild(modal.dialog);
    }
    if (job.manifest !== undefined) {
      card.appendChild(manifestReview(job.manifest));
    }
    if (pending) {
      const progress = document.createElement("p"); progress.setAttribute("role", "status"); progress.className = "job-progress"; progress.textContent = pending; card.appendChild(progress);
    } else if (["uploading", "submitting", "preparing", "executing", "drafting_cover_letter", "tailoring_resume"].includes(job.status)) {
      const progress = document.createElement("p"); progress.setAttribute("role", "status"); progress.className = "job-progress";
      progress.textContent = job.status === "tailoring_resume" ? "In progress · tailoring your resume and typesetting it…" : job.status === "drafting_cover_letter" ? "In progress · writing and compiling your cover letter…" : job.status === "uploading" ? "In progress · uploading your resume and validating application details…" : "In progress · awaiting the submission server’s verified result…";
      card.appendChild(progress);
    }
    const notice = jobNotices.get(job.jobId);
    if (notice && !pending) { const note = document.createElement("p"); note.className = "job-notice"; note.setAttribute("role", "status"); note.textContent = notice; card.appendChild(note); }
    if (job.operation !== undefined) { const op = document.createElement("p"); op.className = "job-operation"; op.textContent = `Submission status: ${valueText(job.operation)}`; card.appendChild(op); }
    const prepareKey = `${job.jobId}:review`;
    const eligible = job.status === "review" && needsInput === 0 && blockers.length === 0 && unsupportedQuestions.length === 0 && Boolean(job.resumeId);
    if (eligible && !attemptedWrites.has(prepareKey)) {
      const action = button(job.customResume ? "Approve application and tailor resume" : hasHostedCoverSlot(job) ? "Approve application and draft cover letter" : "Approve resume upload and prepare application", () => {
        attemptedWrites.add(prepareKey);
        void runJobWrite(job, "Preparing the application for your review…", onRefresh, report, async () => {
          try { return await prepare("{}")(); }
          catch (error) {
            // A definite rejection ran nothing, so the button can come back.
            if (error instanceof HostedRejection) { attemptedWrites.delete(prepareKey); throw error; }
            throw new Error(`${error instanceof Error ? error.message : String(error)} Check its status in the queue before taking another action.`);
          }
        });
      }); action.className = "job-action"; action.dataset.write = ""; card.appendChild(action);
    }
    if (eligible && attemptedWrites.has(prepareKey) && !pending) { const note = document.createElement("p"); note.className = "job-operation"; note.textContent = "Preparation was already requested in this page. Its status updates here automatically. If nothing changes, reload this page."; card.appendChild(note); }
    const confirmKey = `${job.jobId}:confirm_required`;
    if (job.status === "confirm_required" && job.manifestHash && job.manifest !== undefined && !attemptedWrites.has(confirmKey)) {
      const action = button("Confirm and submit", () => {
        attemptedWrites.add(confirmKey);
        void runJobWrite(job, "Submitting the application… Do not retry if the result is uncertain.", onRefresh, report, async () => {
          try { await prepareSession(); const outcome = await trackProgress(job, "submitting", onProgress, onRefresh, () => hostedRequest<{status?: string}>(`/jobs/${encodeURIComponent(job.jobId)}/confirm`, { method: "POST", body: JSON.stringify({ manifestHash: job.manifestHash }) })); return outcome.status === "submitted" ? "Application successfully submitted. See Submitted for the result." : "The outcome needs checking. See Needs review before taking another action."; }
          catch (error) {
            if (error instanceof HostedRejection) { attemptedWrites.delete(confirmKey); throw error; }
            throw new Error(`${error instanceof Error ? error.message : String(error)} Check its status in the queue. Do not repeat a submission if its outcome is uncertain.`);
          }
        });
      }); action.className = "job-action job-confirm"; action.dataset.write = ""; card.appendChild(action);
    }
    if (job.status === "confirm_required" && attemptedWrites.has(confirmKey) && !pending) { const note = document.createElement("p"); note.className = "job-operation"; note.textContent = "Submission was already requested in this page. The outcome updates here automatically; do not repeat an uncertain submission. If nothing changes, reload this page."; card.appendChild(note); }
    if (pending) for (const control of card.querySelectorAll<HTMLButtonElement>("[data-write], .remove-action")) control.disabled = true;
    container.appendChild(card);
  }
}

export function launchHostedSearch(report: StatusMessage, onRefresh: () => void, postingId?: string): () => Promise<boolean> {
  return async () => {
    report("Preparing your WaterlooWorks session…");
    try { await prepareSession(); await hostedRequest("/launch", { method: "POST", body: JSON.stringify(postingId ? { postingId } : {}) }); report(postingId ? `Posting ${postingId} is being prepared. It will appear in your queue when ready.` : "Daily search started. New matches will appear in your queue."); await onRefresh(); return true; }
    catch (error) { report(error instanceof Error ? error.message : String(error)); return false; }
  };
}

/** Keep read-only status refreshes running while the single approved write is outstanding. */
async function trackProgress<T>(job: HostedJob, phase: string, show: () => void, refresh: () => void, write: () => Promise<T>): Promise<T> {
  const previous = job.status;
  job.status = phase; show();
  const timer = setInterval(() => { void refresh(); }, 1500);
  try { return await write(); }
  finally { clearInterval(timer); job.status = previous; void refresh(); }
}
