import type { Tone } from "./hosted-queue.js";
import { hostedRequest } from "./hosted-client.js";
import { approveDocument, type HostedJob, type WriteHooks } from "./hosted-queue.js";
import { renderPdf } from "./hosted-pdf.js";
import { cachedPdf, menuItem, openHostedFile, text, writeButton, type StepContext, type StepView } from "./hosted-step.js";

/** Kept across re-renders: rebuilding the input would discard a file the user has already picked. */
const uploadForms = new Map<string, HTMLFormElement>();
export function letterUploadForm(job: HostedJob, hooks: WriteHooks): HTMLFormElement {
  const existing = uploadForms.get(job.jobId);
  if (existing) { const submit = existing.querySelector<HTMLButtonElement>("button[type=submit]")!; submit.disabled = existing.dataset.uploading === "true"; return existing; }
  const form = document.createElement("form"), label = document.createElement("label"), input = document.createElement("input"), upload = document.createElement("button");
  form.className = "letter-upload"; label.textContent = "Use your own cover letter (PDF, under 5 MB)"; input.type = "file"; input.accept = "application/pdf,.pdf"; input.required = true; label.appendChild(input);
  upload.type = "submit"; upload.dataset.write = ""; upload.className = "secondary"; upload.textContent = "Upload my PDF"; form.append(label, upload);
  form.addEventListener("submit", async event => {
    event.preventDefault(); const file = input.files?.[0]; if (!file) return;
    if (file.size >= 5_000_000) { hooks.report("Choose a PDF smaller than 5 MB."); return; }
    upload.disabled = true; form.dataset.uploading = "true";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await hostedRequest(`/jobs/${encodeURIComponent(job.jobId)}/cover-letter`, { method: "POST", body: JSON.stringify({ name: file.name, base64: btoa(binary) }) });
      uploadForms.delete(job.jobId); hooks.report("Cover letter uploaded. Read it, then approve it."); await hooks.refresh();
    } catch (error) { hooks.report(error instanceof Error ? error.message : String(error), "error"); upload.disabled = false; }
    finally { delete form.dataset.uploading; }
  });
  uploadForms.set(job.jobId, form); return form;
}
/** Forgets a picked file once the job can no longer take one. */
export function forgetLetterUpload(job: HostedJob): void {
  if (!["review", "cover_letter_review", "cover_letter_failed"].includes(job.status)) uploadForms.delete(job.jobId);
}

/** Draws a hosted PDF into `pane`, or explains why it could not, with a way to open it instead. */
export function showPdf(pane: HTMLElement, key: string, path: string, label: string, report: (value: string, tone?: Tone) => void): void {
  pane.replaceChildren(text("p", `Loading ${label.toLowerCase()}…`, "meta pdf-loading"));
  void cachedPdf(key, path).then(async bytes => { pane.replaceChildren(); await renderPdf(pane, bytes, label); }).catch(error => {
    const open = document.createElement("button"); open.type = "button"; open.className = "link"; open.textContent = "Open the PDF in a new tab";
    open.addEventListener("click", () => void openHostedFile(path, report));
    pane.replaceChildren(text("p", `${label} could not be shown here: ${error instanceof Error ? error.message : String(error)}`, "meta pdf-loading"), open);
  });
}

/** Read the letter itself, then approve that exact revision. A failed draft offers a new one or your own PDF. */
export function letterStep(job: HostedJob, ctx: StepContext): StepView {
  const body = document.createElement("div"); body.className = "letter-step";
  const path = `/jobs/${encodeURIComponent(job.jobId)}/cover-letter`, report = ctx.hooks.report;
  const upload = document.createElement("div"); upload.className = "upload-slot"; upload.hidden = true;
  const showUpload = () => { upload.replaceChildren(letterUploadForm(job, ctx.hooks)); upload.hidden = false; upload.querySelector("input")?.focus(); };
  const menu = [menuItem("Upload my own PDF instead", showUpload)];
  const letter = job.coverLetter;
  if (job.status !== "cover_letter_review" || !letter) {
    body.append(text("p", "The cover letter couldn't be built:", "meta"), text("pre", job.coverLetterError || job.reason || "No reason was given.", "error-box"), upload);
    const retry = writeButton("Ask for a new draft", () => ctx.act(() => approveDocument(job, ctx.hooks, {})));
    return { body, primary: retry, help: "You can fix your template in Setup first, or upload your own PDF from ⋯.", menu };
  }
  const pane = document.createElement("div"); pane.className = "pdf-review document";
  body.append(pane, upload);
  showPdf(pane, `letter:${letter.sha256}`, path, "Your cover letter", report);
  if (letter.texKey) menu.push(menuItem("Download LaTeX source", () => void openHostedFile(`${path}?tex=1`, report, `cover-letter-${job.jobId}.tex`)));
  menu.push(menuItem("Open the PDF in a new tab", () => void openHostedFile(path, report)));
  const tailorNext = Boolean(job.customResume && !job.customResume.approved);
  const approve = writeButton(tailorNext ? "Approve letter and tailor resume" : "Approve letter and upload", () => ctx.act(() => approveDocument(job, ctx.hooks, { coverLetterHash: letter.sha256 })));
  return {
    body, primary: approve, menu, wide: true,
    help: tailorNext ? "WatWorks tailors your resume next. Nothing is sent until you approve it." : "This uploads your resume and this letter to WaterlooWorks. Nothing is submitted until your final check.",
  };
}
