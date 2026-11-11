import { valueText } from "./hosted-answers.js";
import { confirmSubmission, hostedJobPending, hostedWriteAttempted, jobEmployer, type HostedJob } from "./hosted-queue.js";
import { menuItem, openHostedFile, text, writeButton, type StepContext, type StepView } from "./hosted-step.js";

interface ManifestDocument { label?: string; document?: { name?: string; revision?: string }; storedDocument?: { name?: string; revision?: string }; file?: { filename?: string; sha256?: string } }
interface ManifestAnswer { question?: string; displayValue?: unknown }
interface ReviewManifest { title?: string; employer?: string; term?: string; deadline?: string; documents?: ManifestDocument[]; answers?: ManifestAnswer[] }

/** Exactly what the submission will send, in full: nothing here is shortened, because Submit confirms all of it. */
export function manifestReview(raw: unknown): HTMLElement {
  const manifest = raw && typeof raw === "object" ? raw as ReviewManifest : {};
  const section = document.createElement("section"); section.className = "manifest-review";
  const facts = [manifest.title, manifest.term, manifest.deadline ? `Deadline ${valueText(manifest.deadline)}` : undefined].filter(value => value !== undefined && value !== "").map(value => valueText(value));
  if (facts.length) section.appendChild(text("p", facts.join(" · "), "meta manifest-facts"));
  section.appendChild(text("h3", "Documents", "manifest-heading"));
  const documents = document.createElement("ul"); documents.className = "manifest-documents";
  for (const item of manifest.documents ?? []) {
    const row = document.createElement("li"), name = item.document ?? item.storedDocument;
    row.append(text("span", item.label || "Document", "k"), text("span", name?.name || item.file?.filename || "No document listed", "v"));
    documents.appendChild(row);
  }
  if (!manifest.documents?.length) documents.appendChild(text("li", "No documents.", "meta"));
  section.appendChild(documents);
  section.appendChild(text("h3", "Answers", "manifest-heading"));
  const answers = document.createElement("dl"); answers.className = "manifest-answers";
  for (const answer of manifest.answers ?? []) answers.append(text("dt", answer.question || "Screening question"), text("dd", valueText(answer.displayValue)));
  if (!manifest.answers?.length) answers.appendChild(text("dd", "No screening answers."));
  section.appendChild(answers);
  return section;
}

/** The last, deliberate step: one job at a time, with everything it sends right above Submit. */
export function finalStep(job: HostedJob, ctx: StepContext): StepView {
  const body = document.createElement("div"); body.className = "final-step";
  body.appendChild(manifestReview(job.manifest));
  const menu: HTMLButtonElement[] = [];
  const resumePath = job.customResume?.approved ? `/jobs/${encodeURIComponent(job.jobId)}/custom-resume` : job.resumeId ? `/resumes/${encodeURIComponent(job.resumeId)}` : undefined;
  if (resumePath) menu.push(menuItem("Preview the resume", () => void openHostedFile(resumePath, ctx.hooks.report)));
  if (job.coverLetter) menu.push(menuItem("Preview the cover letter", () => void openHostedFile(`/jobs/${encodeURIComponent(job.jobId)}/cover-letter${job.processedCoverLetter ? "?processed=1" : ""}`, ctx.hooks.report)));
  if (hostedWriteAttempted(job, "confirm_required") && !hostedJobPending(job.jobId)) {
    body.appendChild(text("p", "Submission was already requested from this page. Its result appears here; do not submit again. If nothing changes, reload this page.", "task-notice"));
    return { body, menu };
  }
  if (!job.manifestHash || job.manifest === undefined) return { body, menu };
  const submit = writeButton(`Submit application to ${jobEmployer(job)}`, () => ctx.act(() => confirmSubmission(job, ctx.hooks), { advance: false }), "job-confirm");
  return { body, primary: submit, menu, help: "This sends the application exactly as listed above. It can't be undone." };
}
