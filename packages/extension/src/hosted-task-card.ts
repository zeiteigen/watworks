import { renderAnswersStep } from "./hosted-answers.js";
import { canOpenApplicationForm, jobMenu, postingDetail } from "./hosted-job-actions.js";
import { forgetLetterUpload, letterStep, letterUploadForm } from "./hosted-letter-ui.js";
import { finalStep } from "./hosted-manifest.js";
import { approveAnswers, checkOutcome, hasHostedCoverSlot, type JobNotice, hostedJobNotice, hostedJobPending, hostedWriteAttempted, jobEmployer, jobTitle, saveAnswers, type HostedJob } from "./hosted-queue.js";
import { customResumeToggle, resumeStep } from "./hosted-resume-ui.js";
import { button, menuItem, openHostedFile, openOnWaterlooWorks, text, writeButton, type StepContext, type StepView } from "./hosted-step.js";
import { dueLabel, externalSteps, hostedTask, taskBlockers } from "./hosted-tasks.js";

export interface CardOptions extends Omit<StepContext, "act"> {
  /** In a review session the card offers Skip; opened from All jobs it offers Back. */
  mode: "session" | "single";
  /** A write started: move on while WatWorks works on it. */
  onAdvance(): void;
  /** Skip for now, Back, or Next once nothing here needs the user. */
  onLeave(): void;
}

interface Notice { element: HTMLElement; show(notice: JobNotice): void; clear(): void }
/**
 * The outcome of this job's last action, right above its button. Errors get a marked block that
 * says plainly that it didn't go through; a reason the server saved survives a reload.
 */
function createNotice(job: HostedJob, waitingOnYou: boolean): Notice {
  const element = document.createElement("div"); element.className = "task-notice";
  const show = (notice: JobNotice) => {
    element.className = `task-notice ${notice.tone}`; element.setAttribute("role", notice.tone === "error" ? "alert" : "status");
    element.replaceChildren(...(notice.tone === "error" ? [text("strong", "That didn’t go through", "notice-title")] : []), text("p", notice.text));
    element.hidden = false;
  };
  const clear = () => { element.replaceChildren(); element.hidden = true; };
  clear();
  const current = hostedJobNotice(job.jobId);
  if (current) show(current);
  else if (job.lastAttemptError && waitingOnYou) show({ text: job.lastAttemptError.message, tone: "error" });
  return { element, show, clear };
}

/** Everything that changes what the card shows. Refreshes that keep it the same leave the card alone. */
export function cardKey(job: HostedJob): string {
  const custom = job.customResume;
  return JSON.stringify([job.jobId, job.status, hostedJobPending(job.jobId) ?? "", hostedJobNotice(job.jobId)?.text ?? "", job.lastAttemptError?.at ?? 0, job.manifestHash ?? "", job.coverLetter?.sha256 ?? "",
    custom ? [custom.draftId, custom.pdf?.sha256, custom.approved?.sha256, custom.accepted?.length] : null,
    job.missingFacts?.length ?? 0, job.answers?.length ?? 0, job.coverLetterError ?? "", job.customResumeError ?? "",
    hostedWriteAttempted(job, "review"), hostedWriteAttempted(job, "confirm_required")]);
}

function answersStep(job: HostedJob, ctx: StepContext, notice: Notice): StepView {
  const step = renderAnswersStep(job, () => notice.clear());
  const body = document.createElement("div"); body.appendChild(step.element);
  const busy = Boolean(hostedJobPending(job.jobId));
  const resumeName = ctx.resumes.find(resume => resume.id === job.resumeId)?.name ?? "Resume unavailable";
  const sending = document.createElement("div"); sending.className = "sending";
  const line = document.createElement("p"); line.append(text("span", "Sending ", "meta"), text("strong", resumeName));
  if (job.resumeId) line.append(" ", button("Preview", () => void openHostedFile(`/resumes/${encodeURIComponent(job.resumeId!)}`, ctx.hooks.report), "link"));
  sending.appendChild(line);
  const tailor = customResumeToggle(job, ctx.hooks, busy); if (tailor) sending.appendChild(tailor);
  body.appendChild(sending);
  const menu: HTMLButtonElement[] = [];
  if (hasHostedCoverSlot(job) && job.status === "review") {
    const upload = document.createElement("div"); upload.className = "upload-slot"; upload.hidden = true; body.appendChild(upload);
    menu.push(menuItem("Use my own cover letter", () => { upload.replaceChildren(letterUploadForm(job, ctx.hooks)); upload.hidden = false; }));
  }
  if (hostedWriteAttempted(job, "review") && !busy) {
    body.appendChild(text("p", "This was already approved from this page. Its status updates here; if nothing changes, reload this page.", "task-notice"));
    return { body, menu };
  }
  const collect = () => { const result = step.collect(); if (typeof result === "string") { notice.show({ text: result, tone: "error" }); return undefined; } return result; };
  // A letter attached before approval is approved on its own step; here the answers are only saved.
  if (job.coverLetter) {
    const save = writeButton("Save answers", () => { const edited = collect(); if (edited) ctx.act(() => saveAnswers(job, ctx.hooks, edited), { advance: false }); });
    return { body, menu, primary: save, help: "Your cover letter is next." };
  }
  const primary = writeButton("These answers are right, continue", () => {
    const edited = collect(); if (!edited) return;
    ctx.act(() => step.editable ? approveAnswers(job, ctx.hooks, edited) : approveAnswers(job, ctx.hooks));
  });
  const help = job.customResume ? "WatWorks tailors your resume next. Nothing is sent until you approve it."
    : hasHostedCoverSlot(job) ? "WatWorks writes your cover letter next. Nothing is sent until you approve it."
    : "This uploads your resume to WaterlooWorks. Nothing is submitted until your final check.";
  return { body, menu, primary, help };
}

function infoStep(job: HostedJob, ctx: StepContext): StepView {
  const task = hostedTask(job), body = document.createElement("div"), report = ctx.hooks.report;
  if (task.kind === "uncertain") {
    body.append(text("p", "WatWorks lost track of this application after it started, so it may or may not have reached the employer."), text("p", "Check WaterlooWorks again reads your WaterlooWorks applications. If it is there, it is marked as sent. If it is not, it goes back to its final check so you can submit it again.", "meta"));
    return { body, primary: writeButton("Check WaterlooWorks again", () => ctx.act(() => checkOutcome(job, ctx.hooks), { advance: false })), help: "Nothing is sent to WaterlooWorks by checking." };
  }
  if (task.kind === "blocked") {
    const list = document.createElement("ul"); list.className = "blockers";
    for (const reason of taskBlockers(job).length ? taskBlockers(job) : [`WatWorks doesn't recognize the status “${job.status.replaceAll("_", " ")}”.`]) list.appendChild(text("li", reason));
    body.append(text("p", "WatWorks can't finish this application. Apply on WaterlooWorks yourself, then remove it from your list.", "meta"), list);
    const open = canOpenApplicationForm(job.status) ? writeButton("Open application form ↗", () => void openOnWaterlooWorks("openApplicationForm", job, report)) : undefined;
    return open ? { body, primary: open } : { body };
  }
  if (task.kind === "submitted") {
    const steps = externalSteps(job);
    body.appendChild(text("p", `Sent to ${jobEmployer(job)}.`));
    if (!steps.length) return { body };
    body.appendChild(text("p", "The employer also asks you to do this on their side:", "meta"));
    const list = document.createElement("ul"); list.className = "external-steps"; for (const step of steps) list.appendChild(text("li", step)); body.appendChild(list);
    return { body, primary: button("Open on WaterlooWorks ↗", () => void openOnWaterlooWorks("openPosting", job, report)) };
  }
  body.append(text("p", `${task.verb}…`, "working"), text("p", "Nothing to do here. It comes back to you when it's ready.", "meta"));
  return { body };
}

function stepFor(job: HostedJob, ctx: StepContext, notice: Notice): StepView {
  switch (hostedTask(job).kind) {
    case "answers": return answersStep(job, ctx, notice);
    case "resume": case "resume_failed": return resumeStep(job, ctx);
    case "letter": case "letter_failed": return letterStep(job, ctx);
    case "final": return finalStep(job, ctx);
    default: return infoStep(job, ctx);
  }
}

/** One job, showing only its current step, one primary action and one way out. */
export function renderTaskCard(job: HostedJob, options: CardOptions): HTMLElement {
  forgetLetterUpload(job);
  const task = hostedTask(job), card = document.createElement("article");
  card.className = `task-card kind-${task.kind}`; card.dataset.job = job.jobId;
  const notice = createNotice(job, task.owner === "you");
  const ctx: StepContext = { ...options, act: (write, settings = {}) => {
    notice.clear();
    void write();
    if (settings.advance !== false) options.onAdvance();
  } };
  const step = stepFor(job, ctx, notice);
  card.classList.toggle("wide", Boolean(step.wide));

  const head = document.createElement("div"); head.className = "task-head";
  const titles = document.createElement("div");
  const due = task.owner === "you" ? dueLabel(job) : undefined;
  const eyebrow = task.owner === "done" ? "Sent" : task.owner === "watworks" ? "WatWorks is on it" : `Step ${task.step} of ${task.steps}`;
  titles.append(text("p", due ? `${eyebrow} · ${due}` : eyebrow, "eyebrow"));
  const title = text("h2", jobTitle(job), "task-title"); title.tabIndex = -1;
  titles.append(title, text("p", jobEmployer(job), "task-employer"));
  const about = document.createElement("section"); about.className = "about"; about.hidden = true;
  const toggleAbout = () => {
    if (!about.childElementCount) { if (job.reason && task.kind !== "uncertain") about.appendChild(text("p", job.reason, "why")); about.appendChild(postingDetail(job)); }
    about.hidden = !about.hidden;
  };
  const more = document.createElement("details"), summary = document.createElement("summary"), menu = document.createElement("div");
  more.className = "more"; summary.textContent = "⋯"; summary.setAttribute("aria-label", "More actions"); menu.className = "menu";
  const blockedPrimaryOpensForm = task.kind === "blocked";
  for (const item of [...(step.menu ?? []), ...jobMenu(job, options.hooks, toggleAbout, { applicationForm: !blockedPrimaryOpensForm })]) {
    item.addEventListener("click", () => { if (!item.textContent?.endsWith("Click again")) more.removeAttribute("open"); });
    menu.appendChild(item);
  }
  more.append(summary, menu);
  head.append(titles, more);
  card.append(head, about, step.body, notice.element);

  const footer = document.createElement("div"); footer.className = "task-footer";
  if (step.help) footer.appendChild(text("p", step.help, "step-help"));
  const row = document.createElement("div"); row.className = "task-actions";
  const leave = options.mode === "single" ? "Back to all jobs" : "Skip for now";
  if (task.owner !== "you" && options.mode === "session") row.appendChild(button("Next", options.onLeave, "primary"));
  else {
    if (step.primary) { step.primary.classList.add("primary"); row.appendChild(step.primary); }
    row.appendChild(button(leave, options.onLeave, "link leave"));
  }
  footer.appendChild(row); card.appendChild(footer);
  if (hostedJobPending(job.jobId)) for (const control of card.querySelectorAll<HTMLButtonElement>("[data-write], .remove-action")) control.disabled = true;
  return card;
}
