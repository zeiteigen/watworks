import type { Tone } from "./hosted-queue.js";
import type { HostedWorkspace } from "./hosted-client.js";
import { hostedJobNotice, jobEmployer, jobTitle, type HostedJob, type WriteHooks } from "./hosted-queue.js";
import { cardKey, renderTaskCard } from "./hosted-task-card.js";
import { dueLabel, externalSteps, hostedTask, needsYou, sortTasks } from "./hosted-tasks.js";
import { missingSetup, onboardingSteps, renderSetupCard, renderSetupDone, setupCardKey, type SetupStep } from "./hosted-onboarding.js";
import { normalizeReviewMode } from "../../shared/src/resume-changes.js";

type Screen = "home" | "session" | "done" | "jobs" | "setup" | "onboarding";
interface Session { queue: string[]; index: number; arrived: number; returned: Set<string>; approved: Set<string>; submitted: Set<string>; single: boolean }
interface Onboarding { queue: SetupStep[]; index: number }
export interface FocusView {
  show(workspace: HostedWorkspace): void;
  /** Walks through whatever Setup is missing, one card at a time. */
  onboard(): void;
}

/**
 * Focus: the user never manages a queue. Home says how much needs them; a review walks
 * through one task at a time. Writes stay inside each step; this file only navigates.
 */
export function createFocusView(root: Document, refresh: () => void | Promise<void>, report: (message: string, tone?: Tone) => void): FocusView {
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  let workspace: HostedWorkspace | undefined, screen: Screen = "home", session: Session | undefined, renderedKey: string | undefined, setupOpened = false;
  let onboarding: Onboarding | undefined, setupKey: string | undefined, releaseSetup: (() => void) | undefined;
  const openGroups = new Set(["you"]);
  const hooks: WriteHooks = { refresh, progress: () => render(), report: (message, tone, jobId) => {
    // The card on screen already shows its own outcome; the page-wide line is for everything else.
    const shown = root.querySelector<HTMLElement>("#task-stage .task-card")?.dataset.job;
    if (screen === "session" && jobId !== undefined && jobId === shown) { report(""); return; }
    report(message, tone);
  } };
  /** The last action on this job was turned away, here or (saved by the server) on an earlier visit. */
  const failed = (job: HostedJob) => hostedTask(job).owner === "you" && (hostedJobNotice(job.jobId)?.tone === "error" || Boolean(job.lastAttemptError));
  const jobs = () => (workspace?.jobs ?? []).filter(job => job.status !== "dismissed");
  const find = (id: string) => jobs().find(job => job.jobId === id);

  function go(next: Screen): void {
    if (next !== "session") { session = undefined; renderedKey = undefined; }
    if (next !== "onboarding") { onboarding = undefined; closeSetupCard(); }
    // A message about the last screen would read as one about this one.
    screen = next; report(""); render();
    root.defaultView?.scrollTo?.({ top: 0 });
  }
  function start(ids: string[], single = false): void {
    if (!ids.length) return;
    session = { queue: ids, index: 0, arrived: 0, returned: new Set(), approved: new Set(), submitted: new Set(), single };
    screen = "session"; renderedKey = undefined; render(); focusTitle();
  }
  function focusTitle(): void { root.querySelector<HTMLElement>(`#${screen === "onboarding" ? "onboarding" : "task"}-stage .task-title`)?.focus(); }
  /** Gives a borrowed form back to Setup before its card leaves the page. */
  function closeSetupCard(): void { releaseSetup?.(); releaseSetup = undefined; setupKey = undefined; }
  function onboard(steps = workspace ? onboardingSteps(workspace) : []): void {
    session = undefined; renderedKey = undefined; closeSetupCard();
    onboarding = { queue: steps, index: 0 }; screen = "onboarding"; report(""); render();
    root.defaultView?.scrollTo?.({ top: 0 }); focusTitle();
  }
  function nextSetupStep(): void {
    if (!onboarding) return;
    onboarding.index++; closeSetupCard(); render(); focusTitle();
  }
  /** Moves past tasks that stopped needing the user while they were waiting in line. */
  function next(): void {
    if (!session) return;
    const waiting = (id: string) => { const job = find(id); return job !== undefined && hostedTask(job).owner === "you"; };
    do session.index++;
    while (session.index < session.queue.length && !waiting(session.queue[session.index]!));
    renderedKey = undefined; render(); focusTitle();
  }

  function render(): void {
    for (const panel of root.querySelectorAll<HTMLElement>("[data-screen-panel]")) panel.hidden = panel.dataset.screenPanel !== screen;
    for (const link of root.querySelectorAll<HTMLElement>(".nav [data-screen]")) {
      if (link.dataset.screen === screen) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    if (!workspace) return;
    renderAlerts();
    if (screen === "home") renderHome();
    else if (screen === "session") renderSession();
    else if (screen === "done") renderDone();
    else if (screen === "jobs") renderJobs();
    else if (screen === "onboarding") renderOnboarding();
    renderSetup();
  }

  function renderAlerts(): void {
    const ai = workspace!.ai, alert = $("#ai-alert");
    // Onboarding is already asking for the connection.
    alert.hidden = ai.available === true || screen === "onboarding";
    alert.querySelector("span")!.textContent = ai.reason || "Connect ChatGPT or add an API key to search and prepare applications.";
  }

  function renderHome(): void {
    const all = jobs(), waiting = needsYou(all), minutes = waiting.reduce((sum, job) => sum + hostedTask(job).minutes, 0), missing = missingSetup(workspace!);
    const hour = new Date().getHours();
    $("#greeting").textContent = hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";
    const heading = $("#home-heading"); heading.replaceChildren();
    if (waiting.length) {
      heading.append(`${waiting.length} ${waiting.length === 1 ? "thing needs" : "things need"} you`);
      const time = root.createElement("span"); time.className = "minutes"; time.textContent = ` · about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`; heading.appendChild(time);
    } else heading.textContent = missing.length ? "Let’s get you set up." : "Nothing needs you right now.";
    const working = all.filter(job => hostedTask(job).owner === "watworks"), sent = all.filter(job => job.status === "submitted"), steps = sent.filter(job => externalSteps(job).length);
    const first = waiting[0];
    $("#home-sub").textContent = first ? `One at a time, most urgent first. First up: ${jobEmployer(first)}${dueLabel(first) ? `, ${dueLabel(first)}` : ""}.`
      : missing.length ? `${missing.length} ${missing.length === 1 ? "step is" : "steps are"} left before WatWorks can search and apply for you. It takes a few minutes.`
      : working.length ? "WatWorks is preparing applications. They appear here when they need you." : "Run today's search to find new matches.";
    $<HTMLButtonElement>("#start-review").hidden = !waiting.length;
    const setup = $<HTMLButtonElement>("#start-setup");
    setup.hidden = !missing.length; setup.classList.toggle("secondary", waiting.length > 0);
    const parts = [working.length ? `WatWorks is preparing ${working.length} more` : "", steps.length ? `${steps.length} ${steps.length === 1 ? "step" : "steps"} left on employer sites` : "", sent.length ? `${sent.length} sent` : ""].filter(Boolean);
    const quiet = $<HTMLButtonElement>("#quiet-toggle"), detail = $("#quiet-detail");
    quiet.hidden = !parts.length; quiet.textContent = parts.join(" · ");
    detail.replaceChildren(...[...working, ...steps].map(job => {
      const row = root.createElement("li"), name = root.createElement("strong"), what = root.createElement("span");
      name.textContent = `${jobTitle(job)} · ${jobEmployer(job)}`;
      what.textContent = job.status === "submitted" ? externalSteps(job).join(" ") : hostedTask(job).verb;
      row.append(name, what); return row;
    }));
    if (!parts.length) { detail.hidden = true; quiet.setAttribute("aria-expanded", "false"); }
  }

  function renderSession(): void {
    if (!session) { go("home"); return; }
    if (!session.single) for (const job of needsYou(jobs())) {
      if (!session.queue.includes(job.jobId)) { session.queue.push(job.jobId); session.arrived++; continue; }
      // An approval that failed after the review moved on brings its job back once, with the reason on it.
      const passed = session.queue.lastIndexOf(job.jobId) < session.index;
      if (passed && session.approved.has(job.jobId) && hostedJobNotice(job.jobId)?.tone === "error" && !session.returned.has(job.jobId)) { session.returned.add(job.jobId); session.queue.push(job.jobId); }
    }
    const id = session.queue[session.index], job = id === undefined ? undefined : find(id);
    if (!job) {
      if (session.index >= session.queue.length) { if (session.single) go("jobs"); else { screen = "done"; render(); } return; }
      next(); return;
    }
    if (job.status === "submitted") session.submitted.add(job.jobId);
    const total = session.queue.length, position = Math.min(session.index + 1, total);
    $("#session-count").textContent = session.single ? "" : `${position} of ${total}`;
    const returned = session.returned.size;
    $("#session-arrived").textContent = [session.arrived ? `${session.arrived} new ${session.arrived === 1 ? "task" : "tasks"} added to the end` : "", returned ? `${returned} came back with a problem` : ""].filter(Boolean).join(" · ");
    $("#session-progress").style.width = session.single ? "0" : `${(session.index / total) * 100}%`;
    const key = `${cardKey(job)}|${session.single}`;
    if (key === renderedKey) return;
    renderedKey = key;
    const current = session;
    $("#task-stage").replaceChildren(renderTaskCard(job, {
      hooks, resumes: workspace!.resumes, reviewMode: normalizeReviewMode(workspace!.resumeReview), mode: session.single ? "single" : "session",
      onAdvance: () => { current.approved.add(job.jobId); if (current.single) go("jobs"); else next(); },
      onLeave: () => { if (current.single) go("jobs"); else next(); },
    }));
  }

  function renderOnboarding(): void {
    if (!onboarding) { go("home"); return; }
    const { queue, index } = onboarding, step = queue[index];
    $("#onboarding-count").textContent = step ? `${index + 1} of ${queue.length}` : "";
    $("#onboarding-progress").style.width = queue.length ? `${(Math.min(index, queue.length) / queue.length) * 100}%` : "100%";
    const key = setupCardKey(step, workspace!);
    if (key === setupKey) return;
    closeSetupCard(); setupKey = key;
    const stage = $("#onboarding-stage");
    if (!step) {
      stage.replaceChildren(renderSetupDone(workspace!, {
        onFinish: () => onboard(missingSetup(workspace!)),
        onSearch: () => { go("home"); root.querySelector<HTMLButtonElement>("#daily-launch")?.click(); },
        onHome: () => go("home"),
      }));
      return;
    }
    const card = renderSetupCard(root, step, workspace!, { position: index + 1, total: queue.length, onNext: nextSetupStep });
    releaseSetup = card.release; stage.replaceChildren(card.element);
  }

  function renderDone(): void {
    const all = jobs(), approved = session?.approved.size ?? 0, submitted = session?.submitted.size ?? 0;
    const working = all.filter(job => hostedTask(job).owner === "watworks").length, left = needsYou(all).length;
    const lines = [
      approved ? `You moved ${approved} ${approved === 1 ? "application" : "applications"} forward.` : "",
      submitted ? `${submitted} ${submitted === 1 ? "application was" : "applications were"} submitted.` : "",
      working ? `WatWorks is still working on ${working}. They come back here when they're ready.` : "",
      left ? `${left} ${left === 1 ? "task is" : "tasks are"} still waiting for you.` : "",
    ].filter(Boolean);
    $("#done-summary").replaceChildren(...(lines.length ? lines : ["You're all caught up."]).map(line => { const row = root.createElement("li"); row.textContent = line; return row; }));
  }

  function row(job: HostedJob): HTMLElement {
    const item = root.createElement("li"), button = root.createElement("button"), title = root.createElement("span"), verb = root.createElement("span");
    button.type = "button"; button.className = "job-row";
    title.className = "row-title"; title.textContent = `${jobTitle(job)} · ${jobEmployer(job)}`;
    const due = hostedTask(job).owner === "you" ? dueLabel(job) : undefined;
    verb.className = "row-verb"; verb.textContent = due ? `${hostedTask(job).verb} · ${due}` : hostedTask(job).verb;
    button.append(title, verb);
    if (failed(job)) { const problem = root.createElement("span"); problem.className = "row-problem"; problem.textContent = "Last attempt didn’t go through"; button.appendChild(problem); } button.addEventListener("click", () => start([job.jobId], true));
    item.appendChild(button); return item;
  }
  function renderJobs(): void {
    const all = jobs();
    const groups: Array<[string, string, HostedJob[]]> = [
      ["you", "Needs you", needsYou(all)],
      ["watworks", "WatWorks is on it", sortTasks(all.filter(job => hostedTask(job).owner === "watworks"))],
      ["done", "Sent", all.filter(job => job.status === "submitted")],
    ];
    $("#job-groups").replaceChildren(...groups.map(([key, label, members]) => {
      const group = root.createElement("details"), summary = root.createElement("summary"), list = root.createElement("ul");
      group.className = "job-group"; group.toggleAttribute("open", openGroups.has(key) && members.length > 0);
      group.addEventListener("toggle", () => { if (group.hasAttribute("open")) openGroups.add(key); else openGroups.delete(key); });
      summary.textContent = `${label} · ${members.length}`; list.className = "job-rows";
      list.append(...members.map(row));
      group.append(summary, list); return group;
    }));
    if (!all.length) { const empty = root.createElement("p"); empty.className = "meta"; empty.textContent = "No jobs yet. Run today's search to find matches."; $("#job-groups").appendChild(empty); }
  }

  function renderSetup(): void {
    const { ai, profile, resumes } = workspace!;
    const summaries: Record<string, string> = {
      connections: ai.available ? ai.apiKey ? `Using your ${ai.apiKey.model} API key` : "ChatGPT connected" : "AI not connected",
      profile: profile ? profile.roles.join(", ") || "Saved" : "Not set up yet",
      resumes: resumes.length ? `${resumes.length} ${resumes.length === 1 ? "resume" : "resumes"}` : "None yet",
      background: profile?.backgroundNotes ? "Added" : "Optional",
    };
    const missing = { connections: !ai.available, profile: !profile, resumes: !resumes.length };
    for (const [key, value] of Object.entries(summaries)) { const node = root.querySelector(`[data-summary="${key}"]`); if (node) node.textContent = value; }
    for (const [key, isMissing] of Object.entries(missing)) root.querySelector(`[data-section="${key}"]`)?.classList.toggle("missing", isMissing);
    const count = Object.values(missing).filter(Boolean).length;
    $("#setup-intro").textContent = count ? `${count} ${count === 1 ? "thing is" : "things are"} missing before WatWorks can apply for you.` : "Everything WatWorks needs is set. Open a section to change it.";
    $<HTMLButtonElement>("#setup-guided").hidden = !count;
    // Missing sections open once; after that the user decides what stays open.
    if (!setupOpened) {
      setupOpened = true;
      for (const [key, isMissing] of Object.entries(missing)) { const section = root.querySelector<HTMLDetailsElement>(`[data-section="${key}"]`); if (section && isMissing) section.setAttribute("open", ""); }
    }
  }

  for (const link of root.querySelectorAll<HTMLElement>("[data-screen]")) link.addEventListener("click", () => go(link.dataset.screen as Screen));
  $("#start-review").addEventListener("click", () => start(needsYou(jobs()).map(job => job.jobId)));
  $("#start-setup").addEventListener("click", () => onboard());
  $("#setup-guided").addEventListener("click", () => onboard());
  $("#leave-onboarding").addEventListener("click", () => go("home"));
  $("#done-home").addEventListener("click", () => go("home"));
  $("#leave-session").addEventListener("click", () => go(session?.single ? "jobs" : "home"));
  $("#quiet-toggle").addEventListener("click", () => {
    const detail = $("#quiet-detail"), toggle = $("#quiet-toggle");
    detail.hidden = !detail.hidden; toggle.setAttribute("aria-expanded", String(!detail.hidden));
  });
  // Menus close when focus or a click moves elsewhere.
  root.addEventListener("click", event => {
    for (const menu of root.querySelectorAll<HTMLDetailsElement>("details.more[open]")) if (!menu.contains(event.target as Node)) menu.removeAttribute("open");
  });
  root.addEventListener("keydown", event => {
    const target = event.target as HTMLElement | null;
    const typing = target?.closest?.("input, textarea, select, [contenteditable]");
    if (event.key === "Escape") {
      const menu = root.querySelector<HTMLDetailsElement>("details.more[open]");
      if (menu) { menu.removeAttribute("open"); menu.querySelector("summary")?.focus(); return; }
      if (screen === "session" && !typing) go(session?.single ? "jobs" : "home");
      if (screen === "onboarding" && !typing) go("home");
      return;
    }
    if (screen === "session" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault(); root.querySelector<HTMLButtonElement>("#task-stage .leave, #task-stage .task-actions .primary:only-child")?.click();
    }
    if (screen === "onboarding" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault(); root.querySelector<HTMLButtonElement>("#onboarding-stage .task-card:not(.setup-done) .leave")?.click();
    }
  });

  return {
    show: next => {
      const first = !workspace;
      workspace = next;
      // A first visit with anything missing walks through it instead of landing on an empty home.
      if (first && missingSetup(next).length) { onboarding = { queue: onboardingSteps(next), index: 0 }; screen = "onboarding"; }
      render();
    },
    onboard: () => onboard(),
  };
}
