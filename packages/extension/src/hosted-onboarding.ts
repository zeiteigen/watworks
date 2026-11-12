import type { HostedWorkspace } from "./hosted-client.js";
import { button, text } from "./hosted-step.js";

/**
 * Onboarding is the review flow pointed at Setup: one card per step, one primary action,
 * Skip for now. Each card borrows the matching Setup form, so both places share one copy of
 * every field and its save handler, and the form goes back to Setup when the card closes.
 */
export type SetupStep = "connections" | "profile" | "resumes" | "background";
const ORDER: SetupStep[] = ["connections", "profile", "resumes", "background"];

/** The form each step borrows from Setup. */
const BODIES: Record<SetupStep, string> = {
  connections: '[data-setup-body="connections"]',
  profile: "#profile-form",
  resumes: '[data-setup-body="resumes"]',
  background: "#context-form",
};
const COPY: Record<SetupStep, { title: string; lead: string }> = {
  connections: { title: "Connect ChatGPT", lead: "WatWorks uses it to search postings, answer screening questions and write cover letters. You can use your own API key instead." },
  profile: { title: "What are you looking for?", lead: "Roles, pay and places guide the daily search. Your eligibility and languages answer screening questions, so WatWorks never guesses them." },
  resumes: { title: "Add your resume", lead: "WatWorks sends your own resume, unchanged unless you ask it to tailor one. Add a few for different kinds of roles and it picks the best one for each posting." },
  background: { title: "Anything your resume leaves out?", lead: "Projects, accomplishments and stories WatWorks can draw on for cover letters and screening answers. Optional, and you can add to it any time." },
};
/** What the final card lists when a required step was skipped. */
const MISSING: Record<SetupStep, string> = {
  connections: "Connect ChatGPT or add an API key",
  profile: "Say what you’re looking for",
  resumes: "Add a resume",
  background: "",
};

/** What WatWorks cannot search or apply without. */
export function missingSetup(workspace: HostedWorkspace): SetupStep[] {
  return ORDER.filter(step => step === "connections" ? workspace.ai.available !== true
    : step === "profile" ? !workspace.profile
    : step === "resumes" ? !workspace.resumes.length : false);
}
/** Onboarding walks through what is missing, plus background notes while they are still empty. */
export function onboardingSteps(workspace: HostedWorkspace): SetupStep[] {
  const missing = missingSetup(workspace);
  return ORDER.filter(step => missing.includes(step) || (step === "background" && !workspace.profile?.backgroundNotes?.trim()));
}
/** Everything that changes what a step's card shows; typing never does, so refreshes leave the card alone. */
export function setupCardKey(step: SetupStep | undefined, workspace: HostedWorkspace): string {
  if (!step) return `done|${missingSetup(workspace).join()}`;
  if (step === "connections") return `${step}|${workspace.ai.available === true}|${Boolean(workspace.ai.apiKey)}`;
  if (step === "resumes") return `${step}|${workspace.resumes.length > 0}`;
  return step;
}

/** Moves a Setup form into the card; the returned function puts it back exactly where it was. */
function borrow(node: Element, into: HTMLElement): () => void {
  const marker = document.createComment("lent to onboarding");
  node.replaceWith(marker); into.appendChild(node);
  return () => { if (marker.parentNode) marker.replaceWith(node); };
}

/** Submits a borrowed form and moves on only once its own handler reports the save went through. */
function saveAndContinue(form: HTMLFormElement, onNext: () => void): { primary: HTMLButtonElement; stop(): void } {
  const primary = button("Save and continue", () => {
    if (primary.disabled || (form.reportValidity && !form.reportValidity())) return;
    primary.disabled = true;
    if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true }));
  });
  primary.dataset.write = "";
  const saved = () => onNext(), failed = () => { primary.disabled = false; };
  form.addEventListener("setup-saved", saved); form.addEventListener("setup-failed", failed);
  return { primary, stop: () => { form.removeEventListener("setup-saved", saved); form.removeEventListener("setup-failed", failed); } };
}

function card(kind: string, eyebrow: string, title: string, lead?: string): { element: HTMLElement; body: HTMLElement; footer(help: string | undefined, primary: HTMLButtonElement | undefined, leave: HTMLButtonElement): void } {
  const element = document.createElement("article"); element.className = `task-card setup-card ${kind}`;
  const head = document.createElement("div"); head.className = "task-head";
  const titles = document.createElement("div"), heading = text("h2", title, "task-title"); heading.tabIndex = -1;
  titles.append(text("p", eyebrow, "eyebrow"), heading);
  if (lead) titles.appendChild(text("p", lead, "task-employer"));
  head.appendChild(titles);
  const body = document.createElement("div"); body.className = "setup-step-body";
  element.append(head, body);
  return { element, body, footer: (help, primary, leave) => {
    const footer = document.createElement("div"), row = document.createElement("div"); footer.className = "task-footer"; row.className = "task-actions";
    if (help) footer.appendChild(text("p", help, "step-help"));
    if (primary) { primary.classList.add("primary"); row.appendChild(primary); }
    row.appendChild(leave); footer.appendChild(row); element.appendChild(footer);
  } };
}

export interface SetupCardOptions {
  position: number; total: number;
  /** The step is done, or the user chose to move past it. */
  onNext(): void;
}
/** One Setup step. Call release() before the card leaves the page so Setup gets its form back. */
export function renderSetupCard(root: Document, step: SetupStep, workspace: HostedWorkspace, options: SetupCardOptions): { element: HTMLElement; release(): void } {
  const view = card(`setup-${step}`, `Step ${options.position} of ${options.total}`, COPY[step].title, COPY[step].lead);
  const node = root.querySelector(BODIES[step]);
  const giveBack = node ? borrow(node, view.body) : () => {};
  let stop = () => {}, primary: HTMLButtonElement | undefined, help: string | undefined;
  if (step === "connections") {
    const ready = workspace.ai.available === true;
    view.element.classList.toggle("ready", ready);
    if (ready) primary = button("Continue", options.onNext);
    help = ready ? "Connected. You can switch between ChatGPT and an API key later in Setup." : "Finish signing in to ChatGPT in the tab that opens, or save an API key. This card updates once it’s connected.";
  } else if (step === "resumes") {
    if (workspace.resumes.length) primary = button("Continue", options.onNext);
    help = workspace.resumes.length ? "Add more now or any time in Setup." : "Upload at least one PDF to continue.";
  } else if (node) {
    const save = saveAndContinue(node as HTMLFormElement, options.onNext); primary = save.primary; stop = save.stop;
    help = step === "profile" ? "You can change any of this later in Setup." : "Saving never calls AI.";
  }
  view.footer(help, primary, button("Skip for now", options.onNext, "link leave"));
  return { element: view.element, release: () => { stop(); giveBack(); } };
}

export interface SetupDoneOptions { onFinish(): void; onSearch(): void; onHome(): void }
/** The last card: either everything WatWorks needs is in place, or what was skipped. */
export function renderSetupDone(workspace: HostedWorkspace, options: SetupDoneOptions): HTMLElement {
  const missing = missingSetup(workspace);
  if (missing.length) {
    const view = card("setup-done", "Almost there", `${missing.length} ${missing.length === 1 ? "step is" : "steps are"} left`, "WatWorks can’t search or prepare applications until these are done.");
    const list = document.createElement("ul"); list.className = "blockers";
    for (const step of missing) list.appendChild(text("li", MISSING[step]));
    view.body.appendChild(list);
    view.footer(undefined, button("Finish setting up", options.onFinish), button("Back to home", options.onHome, "link leave"));
    return view.element;
  }
  const hour = workspace.profile ? `${String(workspace.profile.scheduleHour).padStart(2, "0")}:00` : undefined;
  const view = card("setup-done", "All set", "You’re set up.");
  view.body.append(
    text("p", `WatWorks searches for new matches every day${hour ? ` at ${hour} Toronto time` : ""} and prepares the applications that fit. Each one comes back to you here, one at a time, and nothing is sent until you approve it.`),
    text("p", "Writing prompts and your cover letter template are in Setup if you want to change how letters and tailored resumes read.", "meta"),
  );
  view.footer(undefined, button("Run today’s search", options.onSearch), button("Back to home", options.onHome, "link leave"));
  return view.element;
}
