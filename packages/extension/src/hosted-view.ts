import type { HostedWorkspace } from "./hosted-client.js";
import { renderHostedQueue } from "./hosted-queue.js";
import { HOSTED_DIALOG_CLOSED } from "./hosted-dialog.js";
import { normalizeReviewMode } from "../../shared/src/resume-changes.js";

/** Notebook navigation and queue filters; execution remains in the hosted queue. */
export interface HostedView { (workspace: HostedWorkspace): void; reveal(jobId: string): void; showNew(): void }
export function createHostedView(root: Document, refresh: () => void, report: (message: string) => void): HostedView {
  let workspace: HostedWorkspace | undefined;
  let activeTab = "jobs", filter = "all", deferred = false;
  // New discoveries wait behind a banner so the queue does not shift while it is being reviewed.
  let known: Set<string> | undefined;
  const held = new Set<string>(), revealed = new Set<string>();
  const banner = root.querySelector<HTMLButtonElement>("#new-jobs");
  function showNew(): void { for (const id of held) known?.add(id); held.clear(); }
  function absorb(next: HostedWorkspace): void {
    const ids = new Set(next.jobs.map(job => job.jobId));
    for (const id of held) if (!ids.has(id)) held.delete(id);
    if (!known) { known = ids; return; }
    const visible = next.jobs.some(job => known!.has(job.jobId) && !["dismissed", "submitted"].includes(job.status));
    for (const id of ids) {
      if (known.has(id) || held.has(id)) continue;
      if (revealed.has(id) || activeTab !== "jobs" || !visible) known.add(id); else held.add(id);
    }
  }
  function updateBanner(): void {
    if (!banner) return;
    banner.hidden = held.size === 0 || activeTab !== "jobs";
    banner.textContent = `${held.size} new ${held.size === 1 ? "match" : "matches"} · Show`;
  }
  banner?.addEventListener("click", () => { showNew(); render(); });
  // Closing a job dialog applies any refresh that arrived while it was open.
  root.addEventListener(HOSTED_DIALOG_CLOSED, () => { if (deferred) { deferred = false; render(); } });
  const search = root.querySelector<HTMLInputElement>("#job-search")!;
  const queue = root.querySelector<HTMLElement>("#queue")!;
  const submitted = root.querySelector<HTMLElement>("#submitted")!;
  const applications = root.querySelector<HTMLElement>("#applications")!;

  function render(): void {
    if (!workspace) return;
    updateBanner();
    if (root.querySelector("#queue dialog[open], #applications dialog[open], #submitted dialog[open]")) { deferred = true; return; }
    deferred = false;
    // Only the visible queue owns approval controls, including across tab switches.
    queue.replaceChildren(); applications.replaceChildren(); submitted.replaceChildren();
    if (activeTab !== "jobs" && activeTab !== "applications" && activeTab !== "submitted") return;
    const term = search.value.trim().toLowerCase();
    const jobs = workspace.jobs.filter(job => !held.has(job.jobId)).filter(job => activeTab === "submitted" ? job.status === "submitted" : activeTab === "applications" ?
      ["reserved", "running", "executing", "preparing", "uploading", "submitting", "drafting_cover_letter", "tailoring_resume"].includes(job.status) :
      !["dismissed", "submitted", "reserved", "running", "executing", "preparing", "uploading", "submitting", "drafting_cover_letter", "tailoring_resume"].includes(job.status) &&
      (filter === "all" || (filter === "review" ? !["confirm_required"].includes(job.status) : job.status === filter)) &&
      [job.jobId, job.posting?.title, job.posting?.organization, job.posting?.employer].some(value => value?.toLowerCase().includes(term)));
    root.querySelector("#queue-count")!.textContent = `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`;
    const container = activeTab === "submitted" ? submitted : activeTab === "applications" ? applications : queue;
    if (jobs.length) renderHostedQueue(container, jobs, workspace.resumes, workspace.ai.available, refresh, report, () => selectTab("applications"), normalizeReviewMode(workspace.resumeReview));
    else {
      const empty = root.createElement("p"); empty.className = "empty";
      empty.textContent = activeTab === "submitted" ? "Successfully submitted applications will appear here." : activeTab === "applications" ? "No applications are in progress." :
        workspace.jobs.length ? "No jobs match these filters." : "Your daily matches and prepared postings will appear here.";
      container.appendChild(empty);
    }
  }
  function selectTab(tab: string): void {
    if (tab === "settings" && workspace && !workspace.profile) tab = "onboarding";
    if (!root.querySelector(`[data-workspace-panel="${tab}"]`)) return;
    if (tab === "jobs" && activeTab !== "jobs") showNew();
    activeTab = tab;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      const selected = button.dataset.tab === tab;
      button.classList.toggle("active", selected);
      if (selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
    for (const panel of root.querySelectorAll<HTMLElement>("[data-workspace-panel]")) panel.hidden = panel.dataset.workspacePanel !== tab;
    render();
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-tab], [data-open-tab]")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab ?? button.dataset.openTab!));
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-queue-filter]")) {
    button.addEventListener("click", () => {
      filter = button.dataset.queueFilter!;
      for (const item of root.querySelectorAll<HTMLButtonElement>("[data-queue-filter]")) {
        const selected = item === button; item.classList.toggle("active", selected); item.setAttribute("aria-pressed", String(selected));
      }
      render();
    });
  }
  search.addEventListener("input", render);
  const view = (next: HostedWorkspace) => {
    const workspaceBefore = workspace;
    absorb(next);
    workspace = next;
    root.querySelector<HTMLElement>("#setup-notice")!.hidden = !!next.profile && next.resumes.length > 0 && next.ai.connected === true;
    // Reuse the same controls so drafts and listeners survive onboarding.
    const settings = root.querySelector<HTMLElement>("#settings-panel")!;
    const fields = root.querySelector<HTMLElement>("#onboarding-fields")!;
    const profileForm = root.querySelector<HTMLElement>("#profile-form")!;
    const connection = root.querySelector<HTMLElement>(".connection-settings")!;
    const destination = next.profile ? settings : fields;
    if (connection.parentElement !== destination) destination.appendChild(connection);
    if (profileForm.parentElement !== destination) destination.appendChild(profileForm);
    if (!next.profile && !workspaceBefore) selectTab("onboarding");
    if (next.profile && activeTab === "onboarding") selectTab("jobs");
    if(activeTab === "applications" && workspaceBefore){
      const previousActive = new Set(workspaceBefore.jobs.filter(job=>["uploading","submitting","drafting_cover_letter","tailoring_resume"].includes(job.status)).map(job=>job.jobId));
      const completed = next.jobs.find(job=>previousActive.has(job.jobId)&&["submitted","confirm_required","cover_letter_review","cover_letter_failed","resume_review","resume_failed","uncertain"].includes(job.status));
      if(completed)selectTab(completed.status === "submitted" ? "submitted" : "jobs");
    }
    render();
  };
  return Object.assign(view, { reveal: (jobId: string) => { revealed.add(jobId); if (held.delete(jobId)) known?.add(jobId); }, showNew: () => { showNew(); render(); } });
}
