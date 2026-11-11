import type { Tone } from "./hosted-queue.js";
import { hostedRequest } from "./hosted-client.js";
import type { HostedJob, WriteHooks } from "./hosted-queue.js";
import type { ResumeReviewMode } from "../../shared/src/resume-changes.js";
import type { HostedResume } from "./hosted-client.js";

/** One step of one job, as the task card shows it: a body, at most one primary action, one sentence. */
export interface StepView {
  body: HTMLElement;
  primary?: HTMLButtonElement;
  help?: string;
  /** Alternatives that stay out of the way under ⋯. */
  menu?: HTMLButtonElement[];
  /** Documents need more room than a form. */
  wide?: boolean;
}
export interface StepContext {
  hooks: WriteHooks;
  resumes: HostedResume[];
  reviewMode: ResumeReviewMode;
  /** Starts a write. Unless told otherwise, the review moves on while WatWorks works on it. */
  act(write: () => Promise<void>, options?: { advance?: boolean }): void;
}

export function text(tag: string, value: string, className?: string): HTMLElement {
  const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node;
}
export function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = document.createElement("button"); node.type = "button"; node.textContent = label;
  if (className) node.className = className;
  node.addEventListener("click", onClick); return node;
}
/** A button that starts a WaterlooWorks write; disabled with the rest while one is in flight. */
export function writeButton(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = button(label, onClick, className); node.dataset.write = ""; return node;
}
export function menuItem(label: string, onClick: () => void): HTMLButtonElement { return button(label, onClick, "menu-item"); }

/** Opens a hosted PDF in a new tab, or downloads a LaTeX source. */
export async function openHostedFile(path: string, report: (value: string, tone?: Tone) => void, download?: string): Promise<void> {
  try {
    const blob = await hostedRequest<Blob>(path), url = URL.createObjectURL(blob);
    if (download) { const link = document.createElement("a"); link.href = url; link.download = download; link.click(); }
    else await chrome.tabs.create({ url });
    setTimeout(() => URL.revokeObjectURL(url), 300_000);
  } catch (error) { report(error instanceof Error ? error.message : String(error), "error"); }
}
/** Navigation only: the background opens a tab and never touches a form control. */
export async function openOnWaterlooWorks(type: "openPosting" | "openApplicationForm", job: HostedJob, report: (value: string, tone?: Tone) => void): Promise<void> {
  try {
    const reply = await chrome.runtime.sendMessage({ type, jobId: job.jobId }) as { ok?: boolean; error?: string } | undefined;
    if (!reply?.ok) throw new Error(reply?.error ?? "Could not open WaterlooWorks.");
  } catch (error) { report(error instanceof Error ? error.message : String(error), "error"); }
}

/** PDFs already fetched this session, keyed by revision so a new draft is fetched again. */
const pdfCache = new Map<string, Promise<Uint8Array>>();
export function cachedPdf(key: string, path: string): Promise<Uint8Array> {
  let pending = pdfCache.get(key);
  if (!pending) {
    pending = hostedRequest<Blob>(path).then(async blob => new Uint8Array(await blob.arrayBuffer()));
    pdfCache.set(key, pending); pending.catch(() => pdfCache.delete(key));
  }
  return pending;
}
