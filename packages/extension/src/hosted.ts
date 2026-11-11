import { getHostedAccount, type InsiderAccount } from "./insider-account.js";
import { hostedRequest, streamHostedEvents, type HostedProfile, type HostedResume, type HostedWorkspace } from "./hosted-client.js";
import { hostedQueueNeedsPolling, launchHostedSearch, type Tone } from "./hosted-queue.js";
import { createAccountSync } from "./hosted-signin.js";
import { createFocusView } from "./hosted-focus.js";
import { createAiSettings } from "./hosted-ai-settings.js";
import { createLetterSettings } from "./hosted-letter-settings.js";
import { createMaterialSettings } from "./hosted-material-settings.js";
import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const status = $("#status");
let queueTimer: ReturnType<typeof setTimeout> | undefined;
let queueEvents: AbortController | undefined;
let queueEventCursor = 0;
let eventRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let latestJobIds = new Set<string>();
/** The browser's recognized account, and the account whose workspace this page has loaded. */
let accountEmail: string | null = null;
let loadedEmail: string | null = null;
/** Posting IDs requested from this page that have not reached the queue yet. */
const pendingPostings = new Set<string>();
/** Errors read as an alert that stays in view; anything else is a quiet status line. */
function message(text: string, tone: Tone = "info"): void {
  status.textContent = text; status.classList.toggle("error", tone === "error" && text !== "");
  status.setAttribute("role", tone === "error" ? "alert" : "status");
}
const showWorkspace = createFocusView(document, refreshQueue, message);
const showAi = createAiSettings(document, message, refreshQueue);
const loadLetterSettings = createLetterSettings(document, message);
// The review mode changes how resume changes render, so the queue reloads after a save.
const loadMaterialSettings = createMaterialSettings(document, message, () => void refreshQueue());
function options(select: HTMLSelectElement): void {
  for (let hour = 0; hour < 24; hour++) {
    const option = document.createElement("option"); option.value = String(hour);
    option.textContent = `${String(hour).padStart(2, "0")}:00`;
    select.appendChild(option);
  }
}
function profileFromForm(form: HTMLFormElement): Omit<HostedProfile, "backgroundNotes" | "workingMemory" | "canada" | "unitedStates" | "workTerm"> {
  const values = new FormData(form);
  const pay = String(values.get("minimumHourlyPay") ?? "").trim();
  return {
    eightMonthEligible: values.get("eightMonthEligible") as HostedProfile["eightMonthEligible"],
    roles: String(values.get("roles") ?? "").split(",").map(v => v.trim()).filter(Boolean),
    citizenshipCountries: String(values.get("citizenshipCountries") ?? "").split(",").map(v => v.trim()).filter(Boolean),
    permanentResidencyCountries: String(values.get("permanentResidencyCountries") ?? "").split(",").map(v => v.trim()).filter(Boolean),
    fluentLanguages: String(values.get("fluentLanguages") ?? "").split(",").map(v => v.trim()).filter(Boolean),
    minimumHourlyPay: pay ? Number(pay) : null,
    locations: String(values.get("locations") ?? "").split(",").map(v => v.trim()).filter(Boolean),
    notes: String(values.get("notes") ?? "").trim(),
    scheduleHour: Number(values.get("scheduleHour")),
  };
}
function showProfile(profile: HostedProfile | null): void {
  if (!profile) return;
  const form = $("#profile-form") as HTMLFormElement;
  (form.elements.namedItem("eightMonthEligible") as HTMLSelectElement).value = profile.eightMonthEligible ?? "unknown";
  (form.elements.namedItem("roles") as HTMLInputElement).value = profile.roles.join(", ");
  (form.elements.namedItem("citizenshipCountries") as HTMLInputElement).value = (profile.citizenshipCountries ?? []).join(", ");
  (form.elements.namedItem("permanentResidencyCountries") as HTMLInputElement).value = (profile.permanentResidencyCountries ?? []).join(", ");
  (form.elements.namedItem("fluentLanguages") as HTMLInputElement).value = (profile.fluentLanguages ?? []).join(", ");
  (form.elements.namedItem("minimumHourlyPay") as HTMLInputElement).value = profile.minimumHourlyPay === null ? "" : String(profile.minimumHourlyPay);
  (form.elements.namedItem("locations") as HTMLInputElement).value = profile.locations.join(", ");
  (form.elements.namedItem("notes") as HTMLTextAreaElement).value = profile.notes;
  (form.elements.namedItem("scheduleHour") as HTMLSelectElement).value = String(profile.scheduleHour);
}
function showResumes(resumes: HostedResume[]): void {
  const list = $("#resumes"); list.replaceChildren();
  for (const resume of resumes) {
    const row = document.createElement("li"), name = document.createElement("span"), size = document.createElement("span"), remove = document.createElement("button");
    name.textContent = resume.name; size.textContent = `${(resume.size / 1024).toFixed(0)} KB`; size.className = "hint";
    remove.type = "button"; remove.className = "secondary"; remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove ${resume.name}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try { await hostedRequest(`/resumes/${encodeURIComponent(resume.id)}/remove`, { method: "POST", body: "{}" }); row.remove(); message(`Removed ${resume.name}.`); }
      catch (error) { message(error instanceof Error ? error.message : String(error), "error"); remove.disabled = false; }
    });
    row.append(name, size, remove); list.appendChild(row);
  }
}
function showContext(profile: HostedProfile | null): void {
  const form = $("#context-form") as HTMLFormElement;
  (form.elements.namedItem("backgroundNotes") as HTMLTextAreaElement).value = profile?.backgroundNotes ?? "";
  const memory = $("#working-memory"); memory.replaceChildren();
  const label = document.createElement("label"), field = document.createElement("textarea");
  label.textContent = "Working memory · review or correct remembered answers";
  field.name = "workingMemory"; field.rows = 8; field.maxLength = 5000; field.value = profile?.workingMemory ?? "";
  label.appendChild(field); memory.appendChild(label);
}
$("#context-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>("button")!; button.disabled = true;
  const values = new FormData(form);
  try {
    await hostedRequest("/context", { method: "POST", body: JSON.stringify({ backgroundNotes: values.get("backgroundNotes"), workingMemory: values.get("workingMemory") }) });
    message("Background and working memory saved for future preparation.");
  } catch (error) { message(error instanceof Error ? error.message : String(error), "error"); }
  finally { button.disabled = false; }
});
function showAccount(account: InsiderAccount): void {
  accountEmail = account.email;
  $("#identity").textContent = account.email ? `WaterlooWorks account · ${account.email}` : "Sign in to WaterlooWorks to connect your account.";
  $<HTMLElement>("#signin-alert").hidden = !!account.email && !account.reason;
}
async function load(): Promise<void> {
  message("Loading your workspace…");
  const account = await getHostedAccount(true);
  showAccount(account);
  const workspace = await hostedRequest<HostedWorkspace>();
  loadedEmail = account.email;
  showProfile(workspace.profile); showContext(workspace.profile); showResumes(workspace.resumes);
  showAi(workspace.ai);
  updateQueue(workspace); message("");
  void loadLetterSettings(); void loadMaterialSettings();
}
function updateQueue(workspace: HostedWorkspace): void {
  latestJobIds = new Set(workspace.jobs.map(job => job.jobId));
  for (const id of pendingPostings) {
    const say = (text: string) => { pendingPostings.delete(id); $("#launch-state").textContent = text; message(text); };
    // Runs come newest first. A finished run with no job was skipped: closed, already applied to, or removed by you.
    const run = workspace.runs.find(item => item.kind === "posting" && item.posting_id === id);
    if (latestJobIds.has(id)) say(`Posting ${id} is ready in your list.`);
    else if (run?.status === "failed") { say(`Posting ${id} could not be prepared. Check your WaterlooWorks session and AI connection, then try again.`); message($("#launch-state").textContent ?? "", "error"); }
    else if (run?.status === "ready") say(`Posting ${id} was not added. It may be closed, already applied to, or removed from your list.`);
  }
  const allowed = workspace.ai.available === true;
  const dailyButton = $("#daily-launch") as HTMLButtonElement;
  dailyButton.disabled = !allowed;
  dailyButton.title = allowed ? "" : workspace.ai.reason || "Connect ChatGPT or add an API key in Setup.";
  showWorkspace(workspace);
  if (queueTimer) clearTimeout(queueTimer);
  if (hostedQueueNeedsPolling(workspace)) {
    // Draft completion and stale-operation recovery do not always emit events.
    // Keep a read-only fallback even when the event stream stays connected.
    queueTimer = setTimeout(() => void refreshQueue(), 5000);
    if (!queueEvents) {
      const controller = new AbortController();
      queueEvents = controller;
      void streamHostedEvents(() => {
        if (!eventRefreshTimer) eventRefreshTimer = setTimeout(() => { eventRefreshTimer = undefined; void refreshQueue(); }, 250);
      }, controller.signal, queueEventCursor, cursor => { queueEventCursor = cursor; }).catch(() => {
        if (queueEvents === controller) { queueEvents.abort(); queueEvents = undefined; }
        if (!queueEvents && !queueTimer) queueTimer = setTimeout(() => void refreshQueue(), 5000);
      });
    }
  } else {
    if (queueEvents) { queueEvents.abort(); queueEvents = undefined; }
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = undefined; }
  }
}
async function refreshQueue(): Promise<void> {
  try {
    const workspace = await hostedRequest<HostedWorkspace>();
    showAi(workspace.ai);
    updateQueue(workspace);
  } catch (error) { message(error instanceof Error ? error.message : String(error), "error"); }
}
const profileForm = $("#profile-form") as HTMLFormElement;
options(profileForm.elements.namedItem("scheduleHour") as HTMLSelectElement);
profileForm.addEventListener("submit", async event => {
  event.preventDefault(); const button = profileForm.querySelector<HTMLButtonElement>("button[type=submit]")!; button.disabled = true;
  try { const profile = profileFromForm(profileForm); await hostedRequest("/profile", { method: "POST", body: JSON.stringify(profile) }); await refreshQueue(); $("#saved").textContent = "Saved"; message("Your profile is saved."); }
  catch (error) { message(error instanceof Error ? error.message : String(error), "error"); }
  finally { button.disabled = false; }
});
$("#resume-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget as HTMLFormElement, button = form.querySelector<HTMLButtonElement>("button")!;
  const file = $("#resume-file") as HTMLInputElement;
  const selectedFile = file.files?.[0]; if (!selectedFile) return;
  if (selectedFile.type !== "application/pdf" && !selectedFile.name.toLowerCase().endsWith(".pdf")) { message("Choose a PDF file."); return; }
  if (selectedFile.size >= 5_000_000) { message("This PDF is over the 5 MB limit."); return; }
  button.disabled = true;
  try {
    const bytes = new Uint8Array(await selectedFile.arrayBuffer()); let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await hostedRequest("/resumes", { method: "POST", body: JSON.stringify({ name: (($<HTMLInputElement>("#resume-name").value.trim() || selectedFile.name).replace(/(?:\.pdf)?$/i, ".pdf")), base64: btoa(binary) }) });
    form.reset(); await load(); message("Resume uploaded.");
  } catch (error) { message(error instanceof Error ? error.message : String(error), "error"); }
  finally { button.disabled = false; }
});
$("#launch-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget as HTMLFormElement, button = form.querySelector<HTMLButtonElement>("button")!;
  const state = $("#launch-state"), say = (text: string) => { state.textContent = text; message(text); };
  if (button.disabled) return;
  const postingId = String(new FormData(form).get("postingId") ?? "").trim(); if (!/^\d+$/.test(postingId)) { say("Enter a numeric WaterlooWorks posting ID."); return; }
  if (latestJobIds.has(postingId)) { say(`Posting ${postingId} is already in your list.`); return; }
  if (pendingPostings.has(postingId)) { say(`Posting ${postingId} is already being prepared. It will appear here when ready.`); return; }
  button.disabled = true; button.textContent = "Preparing…";
  // Tracked before launching: the refresh inside the launch may already report an existing run's result.
  pendingPostings.add(postingId);
  try {
    if (await launchHostedSearch(say, refreshQueue, postingId)()) { setTimeout(() => { if (pendingPostings.delete(postingId)) state.textContent = ""; }, 10 * 60_000); form.reset(); }
    else pendingPostings.delete(postingId);
  }
  finally { button.disabled = false; button.textContent = "Prepare"; }
});
$("#daily-launch").addEventListener("click", async event => {
  const button = event.currentTarget as HTMLButtonElement;
  if (button.disabled) return;
  button.disabled = true; button.textContent = "Launching…";
  try { await launchHostedSearch(message, refreshQueue)(); }
  finally { button.disabled = false; button.textContent = "Run today’s search"; }
});
// Background notes can change from preparation (remembered answers); reload them when the section opens.
$<HTMLDetailsElement>('[data-section="background"]').addEventListener("toggle", event => {
  if (!(event.currentTarget as HTMLDetailsElement).open) return;
  void hostedRequest<HostedWorkspace>().then(workspace => showContext(workspace.profile)).catch(error => message(String(error)));
});
/** Read-only: follows sign-in changes. A full load replaces the forms, so it only runs for a new account. */
const accountSync = createAccountSync(async () => {
  try {
    if (loadedEmail === null) { await load(); return; }
    const account = await getHostedAccount(accountEmail === null);
    showAccount(account);
    if (!account.email) message("Sign in to WaterlooWorks to keep working. This page will update when you’re connected.");
    // Every form and per-job map on this page belongs to the old account; only a fresh page is safe.
    else if (account.email !== loadedEmail) location.reload();
    else await refreshQueue();
  } catch (error) { message(error instanceof Error ? error.message : String(error), "error"); }
});
/** Sign-in signals also fire during ordinary browsing, so they only matter until the workspace is connected. */
function signInSignal(): void { if (accountEmail === null || accountEmail !== loadedEmail) accountSync.schedule(); }
const waterlooWorksHost = new URL(WATERLOOWORKS_ORIGIN).hostname;
chrome.cookies.onChanged.addListener(({ cookie }) => { if (cookie.domain.replace(/^\./, "") === waterlooWorksHost) signInSignal(); });
// Returning to this page also picks up new matches and anything a cookie event cannot show.
window.addEventListener("focus", () => void accountSync.run());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void accountSync.run(); });
$("#waterlooworks-signin").addEventListener("click", async event => {
  const button = event.currentTarget as HTMLButtonElement; button.disabled = true; message("Opening WaterlooWorks sign-in…");
  try {
    const reply = await chrome.runtime.sendMessage({ type: "signIn" });
    if (!reply?.ok) throw new Error(reply?.error ?? "Could not open WaterlooWorks sign-in.");
    message("Finish signing in to WaterlooWorks in the other tab. This page will update when you’re connected.");
  } catch (error) { message(error instanceof Error ? error.message : String(error), "error"); }
  finally { button.disabled = false; }
});
$("#chatgpt-connect").addEventListener("click", async event => {
  const button = event.currentTarget as HTMLButtonElement; button.disabled = true; message("Opening ChatGPT sign-in…");
  try {
    const reply = await chrome.runtime.sendMessage({ type: "chatgptSignIn" });
    if (!reply?.ok) throw new Error(reply?.error ?? "Could not start ChatGPT sign-in.");
    message("Finish signing in to ChatGPT in the new tab. This page will update when it’s connected.");
  } catch (error) { message(error instanceof Error ? error.message : String(error), "error"); button.disabled = false; }
});
chrome.runtime.onMessage.addListener((message: unknown) => {
  if ((message as { type?: string } | null)?.type === "waterlooWorksSignedIn") { signInSignal(); return; }
  if (!message || typeof message !== "object" || (message as { type?: string }).type !== "chatgptSignInComplete") return;
  const result = message as { connected?: boolean; email?: string; error?: string };
  if (result.connected) messageStatus(`ChatGPT connected${result.email ? ` · ${result.email}` : ""}.`);
  else messageStatus(result.error || "ChatGPT connection was not completed.", "error");
  void refreshQueue();
});
window.addEventListener("pagehide", () => { accountSync.stop(); queueEvents?.abort(); if (queueTimer) clearTimeout(queueTimer); if (eventRefreshTimer) clearTimeout(eventRefreshTimer); });
function messageStatus(text: string, tone: Tone = "info"): void { message(text, tone); }
void accountSync.run();
